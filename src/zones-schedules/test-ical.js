const axios = require("axios");
const ical = require("node-ical");
const { applyAdeUrlSuffix } = require("./configuration");
const { eventsInWindow } = require("./calendar-events");

const MAX_ICAL_BYTES = 5 * 1024 * 1024;
const TEST_TIMEOUT_MS = 10000;
const MAX_PREVIEW_EVENTS = 3;

// Zones & Schedules UI: fetches and parses a candidate iCalendar URL before it is saved.
async function testIcalUrl(url, { client = axios, timeout = TEST_TIMEOUT_MS, nbrDaysPreview = 10, addSuffixToAdeURL = false, timeZone = "Europe/Paris", now = new Date() } = {}) {
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
  if (!Number.isInteger(nbrDaysPreview) || nbrDaysPreview < 1) throw new Error("Number of days to anticipate must be a whole number, 1 or more");
  if (typeof addSuffixToAdeURL !== "boolean") throw new Error("Add suffix to ADE URL must be true or false");
  let dateFormatter;
  try {
    if (typeof timeZone !== "string" || !timeZone) throw new RangeError();
    dateFormatter = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new Error("Time zone must be a valid IANA time zone");
  }
  const formatDate = (date) => {
    const parts = Object.fromEntries(dateFormatter.formatToParts(date).map(({ type, value }) => [type, value]));
    return `${Number(parts.day)}/${Number(parts.month)} ${parts.hour}:${parts.minute}`;
  };
  const requestUrl = applyAdeUrlSuffix({ url: parsedUrl.href, nbrDaysPreview, addSuffixToAdeURL }, now);

  let response;
  try {
    response = await client.get(requestUrl, {
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
    const events = eventsInWindow(ical.parseICS(content), nbrDaysPreview, now.getTime());
    const eventNames = events.slice(0, MAX_PREVIEW_EVENTS).map((event) =>
      `${event.summary.trim() || "(untitled)"} from ${formatDate(event.start)} to ${formatDate(event.end)}`);
    const preview = eventNames.length ? `\nFirst events:\n${eventNames.join("\n")}` : "";
    return `iCalendar URL tested successfully.\nEvents: ${events.length}${preview}`;
  } catch (error) {
    throw new Error(`The URL response contains invalid iCalendar data: ${error.message}`);
  }
}

module.exports = { testIcalUrl };
