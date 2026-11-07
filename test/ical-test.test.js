const test = require("node:test");
const assert = require("node:assert/strict");
const { testIcalUrl } = require("../src/zones-schedules/test-ical");

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
    await testIcalUrl("https://example.org/events.ics", { client, timeZone: "UTC", now: new Date("2030-10-14T08:00:00Z") }),
    "iCalendar URL tested successfully.\nEvents: 4\nFirst events:\nFirst event from 14/10 09:00 to 14/10 10:00\nSecond event from 15/10 09:00 to 15/10 10:00\nThird event from 16/10 09:00 to 16/10 10:00"
  );
  assert.equal(requestedUrl, "https://example.org/events.ics");
});

test("uses the ADE suffix and limits the preview to the configured horizon", async () => {
  let requestedUrl;
  const client = { get: async (url) => { requestedUrl = url; return { data: calendar }; } };
  const message = await testIcalUrl("https://example.org/events.ics?x=1&lastDate=2020-01-01", {
    client, timeZone: "UTC", now: new Date("2030-10-14T09:30:00Z"), nbrDaysPreview: 2, addSuffixToAdeURL: true
  });
  assert.equal(requestedUrl, "https://example.org/events.ics?x=1&lastDate=2030-10-16");
  assert.equal(message, "iCalendar URL tested successfully.\nEvents: 3\nFirst events:\nFirst event from 14/10 09:00 to 14/10 10:00\nSecond event from 15/10 09:00 to 15/10 10:00\nThird event from 16/10 09:00 to 16/10 10:00");
});

test("reports no events when all events are outside the window", async () => {
  const client = { get: async () => ({ data: calendar }) };
  assert.equal(await testIcalUrl("https://example.org/events.ics", {
    client, now: new Date("2030-10-20T00:00:00Z"), nbrDaysPreview: 1
  }), "iCalendar URL tested successfully.\nEvents: 0");
});

test("includes recurring occurrences in chronological order and excludes past and horizon boundary events", async () => {
  const recurring = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
    "BEGIN:VEVENT", "UID:r1", "DTSTART:20301013T090000Z", "DTEND:20301013T100000Z",
    "RRULE:FREQ=DAILY;COUNT=5", "EXDATE:20301015T090000Z", "SUMMARY:Recurring", "END:VEVENT",
    "BEGIN:VEVENT", "UID:boundary", "DTSTART:20301016T090000Z", "DTEND:20301016T100000Z",
    "SUMMARY:Boundary", "END:VEVENT", "END:VCALENDAR"
  ].join("\r\n");
  const client = { get: async () => ({ data: recurring }) };
  const message = await testIcalUrl("https://example.org/events.ics", {
    client, timeZone: "UTC", now: new Date("2030-10-14T09:00:00Z"), nbrDaysPreview: 2
  });
  assert.match(message, /^iCalendar URL tested successfully\.\nEvents: 1\nFirst events:\nRecurring from 14\/10 \d\d:\d\d to 14\/10 \d\d:\d\d$/);
});

test("rejects invalid preview options", async () => {
  await assert.rejects(testIcalUrl("https://example.org/events.ics", { nbrDaysPreview: 0 }), /whole number/);
  await assert.rejects(testIcalUrl("https://example.org/events.ics", { addSuffixToAdeURL: "true" }), /true or false/);
  await assert.rejects(testIcalUrl("https://example.org/events.ics", { timeZone: "Not/AZone" }), /valid IANA time zone/);
});

test("formats dates and times in the zone's time zone across midnight and daylight saving", async () => {
  const content = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
    "BEGIN:VEVENT", "UID:1", "DTSTART:20301108T224500Z", "DTEND:20301109T001500Z",
    "SUMMARY:Night", "END:VEVENT",
    "BEGIN:VEVENT", "UID:2", "DTSTART:20310330T003000Z", "DTEND:20310330T013000Z",
    "SUMMARY:DST", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const client = { get: async () => ({ data: content }) };
  const night = await testIcalUrl("https://example.org/events.ics", { client, timeZone: "Europe/Paris", now: new Date("2030-11-08T20:00:00Z") });
  assert.match(night, /Night from 8\/11 23:45 to 9\/11 01:15/);
  const dst = await testIcalUrl("https://example.org/events.ics", { client, timeZone: "Europe/Paris", now: new Date("2031-03-30T00:00:00Z") });
  assert.match(dst, /DST from 30\/3 01:30 to 30\/3 03:30/);
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
