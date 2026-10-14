const axios = require("axios");
const ical = require("node-ical");

const MAX_ICAL_BYTES = 5 * 1024 * 1024;
const TEST_TIMEOUT_MS = 10000;

async function testIcalUrl(url, { client = axios, timeout = TEST_TIMEOUT_MS } = {}) {
  if (typeof url !== "string" || !url.trim()) throw new Error("iCal URL is required");

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("Enter a valid iCal URL");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
    throw new Error("iCal URL must use HTTP or HTTPS and cannot contain credentials");
  }

  let response;
  try {
    response = await client.get(parsedUrl.href, {
      timeout,
      responseType: "text",
      transformResponse: (data) => data,
      maxContentLength: MAX_ICAL_BYTES,
      maxRedirects: 3
    });
  } catch (error) {
    throw new Error(`Cannot retrieve iCalendar file: ${error.code || error.message}`);
  }

  const content = typeof response.data === "string" ? response.data : "";
  const isCalendar = /^\s*BEGIN:VCALENDAR\s*$/im.test(content)
    && /^\s*VERSION:2\.0\s*$/im.test(content)
    && /^\s*PRODID:.+$/im.test(content)
    && /^\s*END:VCALENDAR\s*$/im.test(content);
  if (!isCalendar) throw new Error("The URL response is not a valid iCalendar file");

  try {
    const events = Object.values(ical.parseICS(content))
      .filter((event) => event?.type === "VEVENT");
    const eventNames = events.slice(0, 3).map((event) => {
      const summary = event.summary && typeof event.summary === "object" ? event.summary.val : event.summary;
      return String(summary ?? "").trim() || "(untitled)";
    });
    const preview = eventNames.length ? `\nFirst events:\n${eventNames.join("\n")}` : "";
    return `iCalendar URL tested successfully.\nEvents: ${events.length}${preview}`;
  } catch (error) {
    throw new Error(`The URL response contains invalid iCalendar data: ${error.message}`);
  }
}

module.exports = { testIcalUrl };
