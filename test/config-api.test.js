const test = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("../server");
const { createDefaultConfig } = require("../src/default-config");

test("configuration validation includes rooms and schedules", async (context) => {
  const server = app.listen(0);
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/config/validate?roomsSchedules=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...createDefaultConfig(), roomsSchedules: {} })
  });
  const result = await response.json();

  assert.equal(response.status, 400);
  assert.ok(result.errors.some((error) => error.path === "roomsSchedules"));
});
