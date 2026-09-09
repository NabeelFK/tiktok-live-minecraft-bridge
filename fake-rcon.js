// Minimal Source RCON server that logs commands. Used to test bridge.ts reconnect.
const net = require('net');
const PORT = 25575;
let n = 0;
const srv = net.createServer((sock) => {
  console.log('[fake] client connected');
  let buf = Buffer.alloc(0);
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readInt32LE(0);
      if (buf.length < len + 4) break;
      const pkt = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      const id = pkt.readInt32LE(0);
      const type = pkt.readInt32LE(4);
      const body = pkt.subarray(8, pkt.length - 2).toString('utf8');
      if (type === 3) { console.log('[fake] auth'); reply(sock, id, 2, ''); }
      else if (type === 2) { n++; console.log('[fake] cmd:', body); reply(sock, id, 0, 'ok'); }
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => console.log('[fake] client gone, total cmds', n));
});
function reply(sock, id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const out = Buffer.alloc(14 + b.length);
  out.writeInt32LE(10 + b.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  b.copy(out, 12);
  sock.write(out);
}
srv.listen(PORT, '127.0.0.1', () => console.log('[fake] rcon listening on', PORT));
process.on('SIGTERM', () => { console.log('[fake] total cmds', n); process.exit(0); });
