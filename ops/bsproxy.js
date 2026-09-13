#!/usr/bin/env node
// Minimal reverse proxy: 127.0.0.1 -> robinhoodchain.blockscout.com, injecting a Referer header.
//
// WHY THIS EXISTS.
// The canonical mainnet explorer for chain 4663 sits behind a Cloudflare managed challenge, and the
// rule keys on the ABSENCE of a `Referer` header — the VALUE is irrelevant, any Referer at all clears
// it. Browsers send one automatically, so links from the web app are fine. Server-side clients do not:
// `forge`/reqwest never sends one, so `forge verify-contract --verifier-url https://robinhoodchain.
// blockscout.com/api` fails on its very first call with an HTML interstitial, surfacing as
// "Failed to deserialize content: expected value at line 1 column 1" rather than as a 403. Plain curl
// and any fetch-based indexer hit the same wall.
//
// Isolated deterministically in ops/recon/R7-R8-testnet-explorer.md B.3: 5/5 challenged without a
// Referer (bare, browser UA, foundry UA); 5/5 passed with one. Origin and sec-fetch-mode do not help.
//
// USAGE
//   node ops/bsproxy.js &
//   curl -s http://127.0.0.1:8546/api/v2/config/backend-version
//   forge verify-contract <addr> src/Vault.sol:Vault \
//     --chain-id 4663 --verifier blockscout --verifier-url http://127.0.0.1:8546/api --watch
//
// The hosted instance also throttles anonymous traffic ("Too many requests", status=0). For deploy day
// get a key from https://dev.blockscout.com and pass it as --verifier-api-key.
//
// The TESTNET explorer (explorer.testnet.chain.robinhood.com) is self-hosted, has no Cloudflare gate
// and no observed throttling. Do NOT proxy that one — point forge straight at it.

const http = require('http');
const https = require('https');

const UPSTREAM = process.env.BS_UPSTREAM || 'robinhoodchain.blockscout.com';
const PORT = Number(process.env.PORT || 8546);

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers };
      delete headers['host'];
      // Let the upstream answer uncompressed; forge reads the body directly.
      delete headers['accept-encoding'];
      headers['host'] = UPSTREAM;
      // The one header that matters. Value is irrelevant; presence is everything.
      headers['referer'] = `https://${UPSTREAM}/`;
      headers['user-agent'] =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
      if (body.length) headers['content-length'] = String(body.length);

      const up = https.request(
        { host: UPSTREAM, port: 443, path: req.url, method: req.method, headers },
        (r) => {
          res.writeHead(r.statusCode || 502, r.headers);
          r.pipe(res);
        }
      );
      up.on('error', (e) => {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end(String(e));
      });
      if (body.length) up.write(body);
      up.end();
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.error(`bsproxy -> https://${UPSTREAM} listening on http://127.0.0.1:${PORT}`);
  });
