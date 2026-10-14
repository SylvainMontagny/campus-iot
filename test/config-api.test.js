const test = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("../server");
const { createDefaultConfig } = require("../src/default-config");

test("configuration validation includes zones and schedules", async (context) => {
  const server = app.listen(0);
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/config/validate?zonesSchedules=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...createDefaultConfig(), zonesSchedules: {} })
  });
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.ok(result.errors.some((error) => error.path === "zonesSchedules"));

  const icalResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/zones/test-ical`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({})
  });
  assert.equal(icalResponse.status, 502);
  assert.deepEqual(await icalResponse.json(), { ok: false, error: "iCal URL is required" });
});
