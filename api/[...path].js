const { createServer } = require("../server");

const server = createServer();

module.exports = (req, res) => {
  const url = req.url || "/";
  if (!url.startsWith("/api") && !url.startsWith("/shots") && !url.startsWith("/favicon")) {
    req.url = `/api${url.startsWith("/") ? url : `/${url}`}`;
  }
  server.emit("request", req, res);
};
