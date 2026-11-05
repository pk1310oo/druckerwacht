//! Minimaler 3MF-Schreiber für OrcaSlicer – nur gebraucht, wenn Stützen oder Naht gemalt wurden.
//!
//! Orca liest gemalte Bereiche pro Dreieck aus den Attributen `paint_supports` und `paint_seam`
//! (siehe Orca `src/libslic3r/Format/bbs_3mf.cpp`). Für ein ungeteiltes Dreieck ist der Wert
//! eine Hex-Ziffer aus dem Bitstrom von `TriangleSelector::serialize`:
//! 2 Bit „Anzahl geteilter Seiten“ (0) + 2 Bit Zustand → Erzwingen (1) = "4", Blockieren (2) = "8".

use std::collections::HashMap;
use std::io::Write;

pub struct PaintedModel<'a> {
    pub name: &'a str,
    /// Binäre STL in Bettkoordinaten
    pub stl: &'a [u8],
    /// Je Dreieck: 0 nichts, 1 erzwingen, 2 blockieren (leer = nichts gemalt)
    pub support: &'a [u8],
    pub seam: &'a [u8],
}

fn paint_code(state: u8) -> Option<&'static str> {
    match state {
        1 => Some("4"),
        2 => Some("8"),
        _ => None,
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Liest die Dreiecke einer binären STL.
pub fn stl_triangles(stl: &[u8]) -> Result<Vec<[[f32; 3]; 3]>, String> {
    if stl.len() < 84 {
        return Err("Ungültige STL-Daten.".into());
    }
    let n = u32::from_le_bytes([stl[80], stl[81], stl[82], stl[83]]) as usize;
    if stl.len() < 84 + n * 50 {
        return Err("STL-Daten sind unvollständig.".into());
    }
    let f = |o: usize| f32::from_le_bytes([stl[o], stl[o + 1], stl[o + 2], stl[o + 3]]);
    Ok((0..n)
        .map(|i| {
            let o = 84 + i * 50 + 12;
            [
                [f(o), f(o + 4), f(o + 8)],
                [f(o + 12), f(o + 16), f(o + 20)],
                [f(o + 24), f(o + 28), f(o + 32)],
            ]
        })
        .collect())
}

fn model_xml(models: &[PaintedModel]) -> Result<String, String> {
    let mut out = String::with_capacity(1 << 20);
    out.push_str(r#"<?xml version="1.0" encoding="UTF-8"?>"#);
    out.push_str("\n<model unit=\"millimeter\" xml:lang=\"en-US\" xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\">\n");
    out.push_str("<metadata name=\"Application\">Druckerwacht</metadata>\n<resources>\n");
    for (idx, m) in models.iter().enumerate() {
        let tris = stl_triangles(m.stl)?;
        // Gemeinsame Eckpunkte zusammenfassen (exakt gleiche Koordinaten)
        let mut index: HashMap<[u32; 3], usize> = HashMap::new();
        let mut verts: Vec<[f32; 3]> = Vec::new();
        let mut faces: Vec<[usize; 3]> = Vec::with_capacity(tris.len());
        for t in &tris {
            let mut f = [0usize; 3];
            for (k, v) in t.iter().enumerate() {
                let key = [v[0].to_bits(), v[1].to_bits(), v[2].to_bits()];
                f[k] = *index.entry(key).or_insert_with(|| {
                    verts.push(*v);
                    verts.len() - 1
                });
            }
            faces.push(f);
        }
        out.push_str(&format!("<object id=\"{}\" name=\"{}\" type=\"model\">\n<mesh>\n<vertices>\n", idx + 1, xml_escape(m.name)));
        for v in &verts {
            out.push_str(&format!("<vertex x=\"{}\" y=\"{}\" z=\"{}\"/>\n", v[0], v[1], v[2]));
        }
        out.push_str("</vertices>\n<triangles>\n");
        for (i, f) in faces.iter().enumerate() {
            out.push_str(&format!("<triangle v1=\"{}\" v2=\"{}\" v3=\"{}\"", f[0], f[1], f[2]));
            if let Some(c) = m.support.get(i).copied().and_then(paint_code) {
                out.push_str(&format!(" paint_supports=\"{c}\""));
            }
            if let Some(c) = m.seam.get(i).copied().and_then(paint_code) {
                out.push_str(&format!(" paint_seam=\"{c}\""));
            }
            out.push_str("/>\n");
        }
        out.push_str("</triangles>\n</mesh>\n</object>\n");
    }
    out.push_str("</resources>\n<build>\n");
    for idx in 0..models.len() {
        out.push_str(&format!("<item objectid=\"{}\"/>\n", idx + 1));
    }
    out.push_str("</build>\n</model>\n");
    Ok(out)
}

/// Schreibt alle Modelle samt gemalter Bereiche in eine 3MF-Datei.
pub fn write(path: &std::path::Path, models: &[PaintedModel]) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let err = |e: zip::result::ZipError| e.to_string();
    let io = |e: std::io::Error| e.to_string();
    zip.start_file("[Content_Types].xml", opts).map_err(err)?;
    zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>"#)
        .map_err(io)?;
    zip.start_file("_rels/.rels", opts).map_err(err)?;
    zip.write_all(br#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>"#)
        .map_err(io)?;
    zip.start_file("3D/3dmodel.model", opts).map_err(err)?;
    zip.write_all(model_xml(models)?.as_bytes()).map_err(io)?;
    zip.finish().map_err(err)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cube_stl() -> Vec<u8> {
        let v = |x: f32, y: f32, z: f32| [x, y, z];
        let p = [v(0., 0., 0.), v(10., 0., 0.), v(10., 10., 0.), v(0., 10., 0.)];
        let tris = [[p[0], p[2], p[1]], [p[0], p[3], p[2]]];
        let mut b = vec![0u8; 80];
        b.extend_from_slice(&(tris.len() as u32).to_le_bytes());
        for t in tris {
            b.extend_from_slice(&[0u8; 12]);
            for c in t {
                for x in c {
                    b.extend_from_slice(&x.to_le_bytes());
                }
            }
            b.extend_from_slice(&[0, 0]);
        }
        b
    }

    #[test]
    fn writes_paint_attributes_and_shares_vertices() {
        let stl = cube_stl();
        let xml = model_xml(&[PaintedModel { name: "Würfel <1>", stl: &stl, support: &[1, 0], seam: &[0, 2] }]).unwrap();
        assert_eq!(xml.matches("<vertex ").count(), 4, "gemeinsame Ecken werden zusammengefasst");
        assert!(xml.contains(r#"<triangle v1="0" v2="1" v3="2" paint_supports="4"/>"#));
        assert!(xml.contains(r#"paint_seam="8"/>"#));
        assert!(xml.contains("name=\"Würfel &lt;1&gt;\""));
    }
}
