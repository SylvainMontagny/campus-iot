const test = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("../server");

test("serves MQTT status, validates connection settings, and exposes the MQTT view", async (context) => {
  const server = app.listen(0);
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const statusResponse = await fetch(`${baseUrl}/api/mqtt/status`);
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).state, "disconnected");

  const connectResponse = await fetch(`${baseUrl}/api/mqtt/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ server: "broker.local", port: 0, topic: "#" })
  });
  assert.equal(connectResponse.status, 400);
  assert.match((await connectResponse.json()).error, /valid port/);

  const pageResponse = await fetch(baseUrl);
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.match(page, /MQTT connection/);
  assert.match(page, /id="mqtt-topic"/);
  assert.match(page, /id="mqtt-log"/);
});