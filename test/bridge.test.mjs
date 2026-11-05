// Bridge integration test: drives a real PTCommandBridge on an ephemeral port
// (same pattern as the Python tests/test_bridge_security.py).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

process.env.PT_MCP_BRIDGE_TOKEN = "testtoken_testtoken_testtoken1234";

const { PTCommandBridge, report_result_js } = await import(
    "../src/infrastructure/execution/live_bridge.js"
);
const { get_bridge_token, token_fingerprint, BridgeTokenError } = await import(
    "../src/infrastructure/execution/bridge_token.js"
);

const TOKEN = process.env.PT_MCP_BRIDGE_TOKEN;

function rawRequest({ port, method = "GET", path = "/", headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: "127.0.0.1", port, method, path, headers },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString("utf-8"),
                }));
            }
        );
        req.on("error", reject);
        if (body !== null) {
            // The Python handler reads Content-Length only (no chunked decoding);
            // send an explicit length like curl/fetch do (unless the test set one).
            if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-length")) {
                req.setHeader("Content-Length", Buffer.byteLength(body));
            }
            req.write(body);
        }
        req.end();
    });
}

test("bridge endpoints, auth and correlation", async (t) => {
    const bridge = new PTCommandBridge(0);
    await bridge.start();
    const port = bridge.port;
    t.after(() => bridge.stop());

    // /ping: unauthenticated identity document
    let r = await rawRequest({ port, path: "/ping" });
    assert.equal(r.status, 200);
    const ping = JSON.parse(r.body);
    assert.equal(ping.service, "pt-mcp-bridge");
    assert.equal(ping.proto, 1);
    assert.equal(ping.id, token_fingerprint(TOKEN));

    // missing token -> 401 with empty body
    r = await rawRequest({ port, path: "/status" });
    assert.equal(r.status, 401);
    assert.equal(r.body, "");

    // wrong token -> 401
    r = await rawRequest({ port, path: `/status?t=wrongwrongwrongwrongwrongwrong12` });
    assert.equal(r.status, 401);

    // bad Host -> 401 even with the right token (checked before the token)
    r = await rawRequest({
        port, path: `/status?t=${TOKEN}`,
        headers: { Host: `evil.example.com:${port}` },
    });
    assert.equal(r.status, 401);

    // header token works
    r = await rawRequest({ port, path: "/status", headers: { "X-PT-Token": TOKEN } });
    assert.equal(r.status, 200);
    const st = JSON.parse(r.body);
    assert.equal(st.connected, false);
    assert.equal(st.unauth_count, 3);
    assert.deepEqual(st.unauth_paths, ["/status"]);
    assert.equal(st.token_id, token_fingerprint(TOKEN));

    // queue + next round-trip
    r = await rawRequest({ port, method: "POST", path: `/queue?t=${TOKEN}`, body: "cmd-one" });
    assert.equal(r.status, 200);
    assert.equal(r.body, "queued");
    r = await rawRequest({ port, path: `/next?t=${TOKEN}` });
    assert.equal(r.status, 200);
    assert.equal(r.body, "cmd-one");

    // /next marks the bridge connected
    r = await rawRequest({ port, path: `/status?t=${TOKEN}` });
    assert.equal(JSON.parse(r.body).connected, true);

    // result correlation: wait with no result -> 204
    r = await rawRequest({ port, path: `/result?rid=abc&wait=0&t=${TOKEN}` });
    assert.equal(r.status, 204);
    // post a result, then collect it
    r = await rawRequest({ port, method: "POST", path: `/result?t=${TOKEN}&rid=abc`, body: "the-result" });
    assert.equal(r.status, 200);
    assert.equal(r.body, "ok");
    r = await rawRequest({ port, path: `/result?rid=abc&wait=1&t=${TOKEN}` });
    assert.equal(r.status, 200);
    assert.equal(r.body, "the-result");
    // a result without rid is discarded, never stored
    r = await rawRequest({ port, method: "POST", path: `/result?t=${TOKEN}`, body: "orphan" });
    assert.equal(r.status, 200);
    assert.equal(r.body, "discarded");
    // unknown authorised path -> 404
    r = await rawRequest({ port, path: `/nope?t=${TOKEN}` });
    assert.equal(r.status, 404);
    // oversized body -> 413
    r = await rawRequest({
        port, method: "POST", path: `/queue?t=${TOKEN}`,
        headers: { "Content-Length": String((1 << 20) + 1) },
        body: "x",
    });
    assert.equal(r.status, 413);
});

test("report_result_js embeds token before rid", () => {
    const js = report_result_js(54321, TOKEN, "7-3");
    assert.ok(js.includes(`/result?t=${TOKEN}&rid=7-3`));
    assert.ok(js.startsWith("function reportResult(d){"));
});

test("env token gate matches Python (too-short env token is a hard error)", () => {
    const saved = process.env.PT_MCP_BRIDGE_TOKEN;
    process.env.PT_MCP_BRIDGE_TOKEN = "short";
    try {
        assert.throws(() => get_bridge_token(), BridgeTokenError);
    } finally {
        process.env.PT_MCP_BRIDGE_TOKEN = saved;
    }
});
