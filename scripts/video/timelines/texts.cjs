// Gemeinsame Texte aller Videos
module.exports = (lang) => {
  const en = lang === "en";
  return {
    forKE: en ? "For the Creality Ender 3 V3 KE" : "Für den Creality Ender 3 V3 KE",
    tagline: en ? "Monitor, slice and print – one free app." : "Überwachen, slicen, drucken – eine kostenlose App.",
    free: en ? "Free &amp; Open Source" : "Kostenlos &amp; Open Source",
    cta: en ? "Download for free" : "Jetzt kostenlos laden",
    url: en ? "<b>github.com/pk1310oo/druckerwacht</b>" : "<b>github.com/pk1310oo/druckerwacht</b>",
    urlBio: en ? "Link in bio<br><b>github.com/pk1310oo/druckerwacht</b>" : "Link in der Bio<br><b>github.com/pk1310oo/druckerwacht</b>",
  };
};
