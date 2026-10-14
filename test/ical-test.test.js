const test = require("node:test");
const assert = require("node:assert/strict");
const { testIcalUrl } = require("../src/ical-test");

const calendar = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Campus IoT//Schedule Test//EN",
  "BEGIN:VEVENT",
  "UID:event-1",
  "DTSTART:20301014T090000Z",
  "DTEND:20301014T100000Z",
  "SUMMARY:First event",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:event-2",
  "DTSTART:20301015T090000Z",
  "DTEND:20301015T100000Z",
  "SUMMARY:Second event",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:event-3",
  "DTSTART:20301016T090000Z",
  "DTEND:20301016T100000Z",
  "SUMMARY:Third event",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:event-4",
  "DTSTART:20301017T090000Z",
  "DTEND:20301017T100000Z",
  "SUMMARY:Fourth event",
  "END:VEVENT",
  "END:VCALENDAR"
].join("\r\n");

test("accepts and parses a valid iCalendar response", async () => {
  let requestedUrl;
  const client = {
    get: async (url) => {
      requestedUrl = url;
      return { status: 200, data: calendar };
    }
  };

  assert.equal(
    await testIcalUrl("https://example.org/events.ics", { client }),
    "iCalendar URL tested successfully.\nEvents: 4\nFirst events:\nFirst event\nSecond event\nThird event"
  );
  assert.equal(requestedUrl, "https://example.org/events.ics");
});

test("rejects a response that is not an iCalendar file", async () => {
  const client = { get: async () => ({ status: 200, data: "<html>Not a calendar</html>" }) };

  await assert.rejects(testIcalUrl("https://example.org/events.ics", { client }), {
    message: "The URL response is not a valid iCalendar file"
  });
});

test("requires an HTTP or HTTPS URL without embedded credentials", async () => {
  await assert.rejects(testIcalUrl("file:///events.ics"), {
    message: "iCal URL must use HTTP or HTTPS and cannot contain credentials"
  });
  await assert.rejects(testIcalUrl("https://user:password@example.org/events.ics"), {
    message: "iCal URL must use HTTP or HTTPS and cannot contain credentials"
  });
});

test("reports errors retrieving the iCalendar response", async () => {
  const client = { get: async () => { throw new Error("ECONNREFUSED"); } };

  await assert.rejects(testIcalUrl("https://example.org/events.ics", { client }), {
    message: "Cannot retrieve iCalendar file: ECONNREFUSED"
  });
});
