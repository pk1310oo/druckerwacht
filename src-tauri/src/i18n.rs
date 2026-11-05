//! Sprache der Meldungen aus dem Backend. Die Oberfläche teilt die aktive Sprache
//! über `set_ui_language` mit; Standard ist Deutsch.

use std::sync::atomic::{AtomicBool, Ordering};

static EN: AtomicBool = AtomicBool::new(false);

pub fn set_english(on: bool) {
    EN.store(on, Ordering::Relaxed);
}

pub fn en() -> bool {
    EN.load(Ordering::Relaxed)
}

/// Fester Text in der aktiven Sprache.
pub fn tr(de: &'static str, en_text: &'static str) -> &'static str {
    if en() {
        en_text
    } else {
        de
    }
}

/// Wie `format!`, aber mit deutscher und englischer Vorlage.
#[macro_export]
macro_rules! trf {
    ($de:literal, $en:literal $(, $arg:expr)* $(,)?) => {
        if $crate::i18n::en() { format!($en $(, $arg)*) } else { format!($de $(, $arg)*) }
    };
}
