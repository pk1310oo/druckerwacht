//! KI-Fehlerwächter: erkennt „Spaghetti“ und abgelöste Drucke im Kamerabild.
//!
//! Nutzt das offene Modell von Obico (The Spaghetti Detective, AGPL-3.0 wie Druckerwacht),
//! ausgeführt lokal mit tract (reines Rust, keine Cloud). Das Modell (~200 MB) wird auf Wunsch
//! einmal heruntergeladen. Bewertung wie bei Obico: Summe der Erkennungs-Konfidenzen je Bild,
//! geglättet (EWM) und mit dem langfristigen Grundrauschen der eigenen Kamera verglichen.
//! Quelle der Logik: obico-server `ml_api/lib/onnx.py` und `backend/lib/prediction.py`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tract_onnx::prelude::*;

pub const MODEL_URL: &str = "https://tsd-pub-static.s3.amazonaws.com/ml-models/model-weights-5a6b1be1fa.onnx";
pub const MODEL_SIZE: u64 = 202_223_918;
const SIDE: usize = 416;
/// Ab dieser Konfidenz zählt ein Kästchen (Obico ml_api: THRESH = 0.08)
const DET_THRESH: f32 = 0.08;
const NMS: f32 = 0.45;

// Obico-Parameter (backend/config/settings.py)
const EWM_SPAN: f32 = 12.0;
const ROLLING_WIN_SHORT: f32 = 310.0;
const ROLLING_WIN_LONG: f32 = 7200.0;
const THRESHOLD_LOW: f32 = 0.38;
const THRESHOLD_HIGH: f32 = 0.78;
const INIT_SAFE_FRAME_NUM: u32 = 30;
const ROLLING_MEAN_SHORT_MULTIPLE: f32 = 3.8;
pub const ESCALATING_FACTOR: f32 = 1.75;

type Plan = SimplePlan<TypedFact, Box<dyn TypedOp>, Graph<TypedFact, Box<dyn TypedOp>>>;

pub struct Detector {
    plan: Plan,
}

impl Detector {
    pub fn load(path: &Path) -> Result<Self, String> {
        let plan = tract_onnx::onnx()
            .model_for_path(path)
            .and_then(|m| m.with_input_fact(0, f32::fact([1, 3, SIDE, SIDE]).into()))
            .and_then(|m| m.into_optimized())
            .and_then(|m| m.into_runnable())
            .map_err(|e| format!("KI-Modell: {e}"))?;
        Ok(Self { plan })
    }

    /// Erkennungen in einem JPEG-Bild: (Konfidenz, [x1, y1, x2, y2] relativ 0–1)
    pub fn detect(&self, jpeg: &[u8]) -> Result<Vec<(f32, [f32; 4])>, String> {
        let img = image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?.to_rgb8();
        let img = image::imageops::resize(&img, SIDE as u32, SIDE as u32, image::imageops::FilterType::Triangle);
        let mut data = vec![0f32; 3 * SIDE * SIDE];
        for (x, y, p) in img.enumerate_pixels() {
            let i = y as usize * SIDE + x as usize;
            for c in 0..3 {
                data[c * SIDE * SIDE + i] = p[c] as f32 / 255.0;
            }
        }
        let input: Tensor = tract_ndarray::Array4::from_shape_vec((1, 3, SIDE, SIDE), data).map_err(|e| e.to_string())?.into();
        let out = self.plan.run(tvec!(input.into())).map_err(|e| e.to_string())?;
        let boxes = out[0].to_array_view::<f32>().map_err(|e| e.to_string())?;
        let confs = out[1].to_array_view::<f32>().map_err(|e| e.to_string())?;
        let n = confs.len();
        let mut found: Vec<(f32, [f32; 4])> = (0..n)
            .filter_map(|i| {
                let c = confs[[0, i, 0]];
                (c > DET_THRESH).then(|| (c, [boxes[[0, i, 0, 0]], boxes[[0, i, 0, 1]], boxes[[0, i, 0, 2]], boxes[[0, i, 0, 3]]]))
            })
            .collect();
        Ok(nms(&mut found))
    }
}

fn iou(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    let w = (a[2].min(b[2]) - a[0].max(b[0])).max(0.0);
    let h = (a[3].min(b[3]) - a[1].max(b[1])).max(0.0);
    let inter = w * h;
    let area = |r: &[f32; 4]| (r[2] - r[0]) * (r[3] - r[1]);
    inter / (area(a) + area(b) - inter).max(1e-9)
}

fn nms(found: &mut [(f32, [f32; 4])]) -> Vec<(f32, [f32; 4])> {
    found.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut keep: Vec<(f32, [f32; 4])> = Vec::new();
    for f in found.iter() {
        if keep.iter().all(|k| iou(&k.1, &f.1) <= NMS) {
            keep.push(*f);
        }
    }
    keep
}

/// Geglätteter Zustand wie Obico `PrinterPrediction`
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Prediction {
    pub current_p: f32,
    pub current_frame_num: u32,
    pub lifetime_frame_num: u32,
    pub ewm_mean: f32,
    pub rolling_mean_short: f32,
    pub rolling_mean_long: f32,
}

impl Prediction {
    pub fn update(&mut self, p: f32) {
        let alpha = 2.0 / (EWM_SPAN + 1.0);
        self.current_p = p;
        self.current_frame_num += 1;
        self.lifetime_frame_num += 1;
        self.ewm_mean = p * alpha + self.ewm_mean * (1.0 - alpha);
        let win = |w: f32, count: u32| if w <= count as f32 { w } else { count as f32 + 1.0 };
        self.rolling_mean_short += (p - self.rolling_mean_short) / win(ROLLING_WIN_SHORT, self.current_frame_num);
        self.rolling_mean_long += (p - self.rolling_mean_long) / win(ROLLING_WIN_LONG, self.lifetime_frame_num);
    }

    /// Neuer Druck: Kurzzeitwerte zurücksetzen, das Grundrauschen der Kamera bleibt
    pub fn reset_print(&mut self) {
        self.current_frame_num = 0;
        self.ewm_mean = 0.0;
        self.rolling_mean_short = 0.0;
        self.current_p = 0.0;
    }

    pub fn is_failing(&self, sensitivity: f32, escalating: f32) -> bool {
        if self.current_frame_num < INIT_SAFE_FRAME_NUM {
            return false;
        }
        let adjusted = (self.ewm_mean - self.rolling_mean_long) * sensitivity / escalating;
        if adjusted < THRESHOLD_LOW {
            return false;
        }
        if adjusted > THRESHOLD_HIGH {
            return true;
        }
        adjusted > (self.rolling_mean_short - self.rolling_mean_long) * ROLLING_MEAN_SHORT_MULTIPLE
    }
}

/// Geladenes Modell (lazy, einmal je App-Start)
pub type Shared = Arc<Mutex<Option<Arc<Detector>>>>;

pub fn model_path(data_dir: &Path) -> PathBuf {
    data_dir.join("ai").join("obico-model.onnx")
}

pub fn model_ready(path: &Path) -> bool {
    std::fs::metadata(path).map(|m| m.len() == MODEL_SIZE).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prediction_like_obico() {
        let mut p = Prediction::default();
        // Ruhige Kamera: kleines Grundrauschen
        for _ in 0..200 {
            p.update(0.05);
        }
        assert!(!p.is_failing(1.0, 1.0));
        // Plötzlich viele Erkennungen (Spaghetti)
        for _ in 0..20 {
            p.update(2.0);
        }
        assert!(p.is_failing(1.0, 1.0));
        assert!(p.is_failing(1.0, ESCALATING_FACTOR));
        // Zu Druckbeginn nie Alarm
        let mut q = Prediction::default();
        for _ in 0..10 {
            q.update(3.0);
        }
        assert!(!q.is_failing(1.0, 1.0));
    }

    #[test]
    fn nms_keeps_best() {
        let mut v = vec![(0.3, [0.0, 0.0, 1.0, 1.0]), (0.9, [0.0, 0.0, 1.0, 0.9]), (0.2, [2.0, 2.0, 3.0, 3.0])];
        let k = nms(&mut v);
        assert_eq!(k.len(), 2);
        assert_eq!(k[0].0, 0.9);
    }

    /// Echter Test mit dem Modell: DW_AI_DIR=<ordner mit obico-model.onnx und detached-1.jpg>
    #[test]
    fn real_model() {
        let Ok(dir) = std::env::var("DW_AI_DIR") else { return };
        let d = Detector::load(&Path::new(&dir).join("model.onnx")).unwrap();
        let jpeg = std::fs::read(Path::new(&dir).join("detached-1.jpg")).unwrap();
        let found = d.detect(&jpeg).unwrap();
        let sum: f32 = found.iter().map(|f| f.0).sum();
        println!("detections {} sum {sum}", found.len());
        assert!(sum > 0.3, "Fehlbild sollte erkannt werden");
    }
}
