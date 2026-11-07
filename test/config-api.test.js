const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { app } = require("../server");
const { createDefaultConfig } = require("../src/config/defaults");

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

test("iCal test endpoint uses requested horizon and ADE suffix", async (context) => {
  let requestedUrl;
  const start = new Date(Date.now() + 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const format = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const calendar = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
    "BEGIN:VEVENT", "UID:1", `DTSTART:${format(start)}`, `DTEND:${format(end)}`,
    "SUMMARY:Future event", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const calendarServer = http.createServer((request, response) => {
    requestedUrl = request.url;
    response.writeHead(200, { "Content-Type": "text/calendar" });
    response.end(calendar);
  }).listen(0, "127.0.0.1");
  await new Promise((resolve) => calendarServer.once("listening", resolve));
  const server = app.listen(0);
  context.after(() => Promise.all([
    new Promise((resolve) => calendarServer.close(resolve)),
    new Promise((resolve) => server.close(resolve))
  ]));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/zones/test-ical`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: `http://127.0.0.1:${calendarServer.address().port}/calendar`, nbrDaysPreview: 1, addSuffixToAdeURL: true, timeZone: "UTC" })
  });
  assert.equal(response.status, 200);
  const display = (date) => `${date.getUTCDate()}/${date.getUTCMonth() + 1} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  assert.equal((await response.json()).message, `iCalendar URL tested successfully.\nEvents: 1\nFirst events:\nFuture event from ${display(start)} to ${display(end)}`);
  assert.match(requestedUrl, /^\/calendar\?lastDate=\d{4}-\d{2}-\d{2}$/);
});
