// Servidor estático mínimo para servir la app (sin dependencias).
// Uso: node server.js  ->  http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

const PUERTO = process.env.PORT || 3000;
const RAIZ = __dirname;
const TIPOS = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".ico": "image/x-icon", ".svg": "image/svg+xml" };

http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]);
  const archivo = path.join(RAIZ, rel === "/" ? "index.html" : rel);
  if (!archivo.startsWith(RAIZ)) { res.writeHead(403).end("Prohibido"); return; }
  fs.readFile(archivo, (err, buf) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("No encontrado"); return; }
    res.writeHead(200, { "Content-Type": TIPOS[path.extname(archivo)] || "application/octet-stream" });
    res.end(buf);
  });
}).listen(PUERTO, () => console.log(`AppClima en http://localhost:${PUERTO}`));
