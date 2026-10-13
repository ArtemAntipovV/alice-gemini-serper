module.exports = async function handler(req, res) {
  try {
    const { path = [] } = req.query;
    const sub = Array.isArray(path) ? path.join("/") : path;
    const url = new URL(req.url, `https://${req.headers.host}`);

    const target =
      "https://generativelanguage.googleapis.com/" + sub + url.search;

    const r = await fetch(target, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: req.method === "GET" ? undefined : JSON.stringify(req.body ?? {})
    });

    const text = await r.text();
    res.status(r.status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.send(text);
  } catch (e) {
    console.error("Relay failed:", e.message);
    res.status(502).json({ error: "Relay failed: " + e.message });
  }
};
