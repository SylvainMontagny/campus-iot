const axios = require("axios");
const https = require("node:https");
const ical = require("node-ical");
const { validateRoomsSchedules, resolveRooms } = require("./rooms-config");

// unref so a pending wait never keeps the process alive.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

function formatDuration(seconds) {
  let remaining = Math.floor(seconds);
  const parts = [];
  for (const [unit, duration] of [["hour", 3600], ["min", 60], ["sec", 1]]) {
    const value = Math.floor(remaining / duration);
    remaining %= duration;
    if (value > 0) parts.push(`${value} ${unit}${value === 1 ? "" : "s"}`);
  }
  return parts.join(" ") || "0 secs";
}

function createApi(connection) {
  return axios.create({
    baseURL: `https://${connection.ipAddress}/api/rest/v2`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${connection.bacnetLogin}:${connection.bacnetPassword}`).toString("base64")}`,
      "Content-Type": "application/json"
    },
    // BMS controllers use self-signed certificates.
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    timeout: 60000
  });
}

async function batch(api, requests) {
  if (!requests.length) return [];
  const numbered = requests.map((request, index) => ({ id: String(index + 1), ...request }));
  return (await api.post("/batch", { requests: numbered })).data;
}

/** Date parts as seen in a given time zone. */
function tzParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const p = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day,
    dateKey: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}:${p.second}`
  };
}

const text = (value) => (value && typeof value === "object" ? String(value.val ?? "") : String(value ?? ""));

/** Fetch the room iCal and return plain {start, end, summary, description} within the preview window. */
async function fetchEvents(room) {
  const data = await ical.async.fromURL(room.url);
  const now = Date.now();
  const horizon = now + room.nbrDaysPreview * 86400000;
  const out = [];

  for (const event of Object.values(data)) {
    if (event.type !== "VEVENT") continue;
    const summary = text(event.summary);
    const description = text(event.description);
    const duration = event.end - event.start;

    // Simplified recurrence handling (no RECURRENCE-ID overrides)
    const starts = event.rrule
      ? event.rrule.between(new Date(now - duration), new Date(horizon), true)
        .filter((date) => !(event.exdate && event.exdate[date.toISOString().slice(0, 10)]))
      : [event.start];

    for (const startDate of starts) {
      const start = new Date(startDate);
      const end = new Date(start.getTime() + duration);
      if (end.getTime() > now && start.getTime() < horizon) out.push({ start, end, summary, description });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Build the "special-events" object for one room. */
function buildSpecialEvents(room, rawEvents, warn = () => {}) {
  const tz = room.timeZone;
  let events = rawEvents.filter((event) => !room.eventsToDiscard.some((name) => event.description.includes(name)));

  if (room.groupEvents) {
    const byDay = new Map();
    for (const event of events) {
      const key = tzParts(event.start, tz).dateKey;
      const current = byDay.get(key);
      if (!current) byDay.set(key, { ...event, summary: "Merged Events" });
      else {
        if (event.start < current.start) current.start = event.start;
        if (event.end > current.end) current.end = event.end;
      }
    }
    events = [...byDay.values()];
  }

  const special = {};
  let eventID = 1;

  events.forEach((event, index) => {
    if (!room.groupEvents) {
      const duration = (event.end - event.start) / 60000;
      if (duration < room.minimumSlotDuration) {
        warn(`Room ${room.scheduleName}: event ${index} "${event.summary}" discarded (duration < ${room.minimumSlotDuration} min).`);
        return;
      }
    }

    const originalDay = tzParts(event.start, tz);
    let startTime;
    let endTime;

    if (room.groupEvents) {
      const start = new Date(event.start.getTime() - room.timeOffsetBeforeStart * 60000);
      const end = new Date(event.end.getTime() - room.timeOffsetBeforeEnd * 60000);
      const startParts = tzParts(start, tz);
      startTime = startParts.time;
      // The offset may push the start into the previous day.
      if (startParts.dateKey < originalDay.dateKey) {
        startTime = "00:00:00";
        warn(`Room ${room.scheduleName}: event ${index} "${event.summary}" clamped to midnight.`);
      }
      endTime = tzParts(end, tz).time;
      if (startTime >= endTime) {
        warn(`Room ${room.scheduleName}: event ${index} "${event.summary}" discarded (start >= end).`);
        return;
      }
    } else {
      startTime = tzParts(event.start, tz).time;
      endTime = tzParts(event.end, tz).time;
    }

    special[eventID] = {
      "event-priority": 16,
      period: {
        date: { month: originalDay.month, year: originalDay.year, "day-of-month": originalDay.day },
        type: "Date"
      },
      name: event.summary,
      transitions: {
        1: { time: startTime, value: room.valueOccupied, key: "1" },
        2: { time: endTime, value: null, key: "2" }
      },
      key: String(eventID)
    };
    eventID++;
  });

  return special;
}

function createIcalScheduleService({ log = () => {} } = {}) {
  let generation = 0;
  // Configurations saved before the log options existed keep every message.
  const logEnabled = (conf, option) => conf.logs?.[option] !== false;

  async function setupSchedules(api, rooms, conf) {
    const [min, max] = conf.scheduleInstanceRange;
    const deletions = [];
    for (let i = min; i <= max; i++) {
      deletions.push({ method: "DELETE", url: `/api/rest/v2/services/bacnet/local/objects/schedules/${i}` });
    }
    await batch(api, deletions);

    await batch(api, rooms.map((room) => ({
      method: "POST",
      url: "/api/rest/v2/services/bacnet/local/objects/add",
      body: { "object-type": "schedule", "instance-number": room.scheduleID, name: room.scheduleName }
    })));

    await batch(api, rooms.map((room) => ({
      method: "POST",
      url: `/api/rest/v2/services/bacnet/local/objects/schedules/${room.scheduleID}`,
      body: { "schedule-default": 19, description: `Room ${room.scheduleName}` }
    })));
  }

  async function setupScheduleAV(api, rooms, conf) {
    const [min, max] = conf.scheduleInstanceRange;
    const offset = conf.scheduleAVInstanceOffset;
    const deletions = [];
    for (let i = min; i <= max; i++) {
      deletions.push({ method: "DELETE", url: `/api/rest/v2/services/bacnet/local/objects/analog-values/${i + offset}` });
    }
    await batch(api, deletions);

    await batch(api, rooms.map((room) => ({
      method: "POST",
      url: "/api/rest/v2/services/bacnet/local/objects/add",
      body: { "object-type": "AnalogValue", "instance-number": room.scheduleID + offset, name: `scheduleAV-${room.scheduleName}` }
    })));

    await batch(api, rooms.map((room) => ({
      method: "POST",
      url: `/api/rest/v2/services/bacnet/local/objects/analog-values/${room.scheduleID + offset}`,
      body: { "default-value": room.valueOccupied }
    })));
  }

  async function setupBindings(api, rooms, conf, deviceList) {
    const existing = (await api.get("/services/events/bindings")).data;
    if (existing && typeof existing === "object") {
      await batch(api, Object.keys(existing).map((name) => ({
        method: "DELETE",
        url: `/api/rest/v2/services/events/bindings/${name}`
      })));
    }

    const offset = conf.scheduleAVInstanceOffset;
    const requests = [];
    for (const room of rooms) {
      for (const [type, device] of Object.entries(room.devices)) {
        const bacnet = deviceList[type].bacnet;
        const objectOffset = bacnet.objects[device.AVToBindName].instanceNum;
        for (const number of device.deviceNums) {
          const avInstance = bacnet.instanceRangeAV * number + objectOffset + bacnet.offsetAV;
          requests.push({
            method: "POST",
            url: `/api/rest/v2/services/events/bindings/binding_scheduleAV-${room.scheduleName}_${device.AVToBindName}-${avInstance}`,
            body: {
              type: "ControlElement",
              "element-a": `/services/bacnet/local/objects/analog-values/${offset + room.scheduleID}`,
              "element-b": `/services/bacnet/local/objects/analog-values/${avInstance}`,
              initialize: "a-to-b",
              "sync-a-to-b": {
                options: { priorities: true, "write-priority": 14, value: false, "out-of-service": true },
                triggers: { 1: { key: "1", "min-sync-time": 0.0, type: "OnChange" } }
              }
            }
          });
        }
      }
    }
    await batch(api, requests);
  }

  async function updateRoomSchedule(api, room) {
    const special = buildSpecialEvents(room, await fetchEvents(room), (message) => log("warning", message));
    await api.post(`/services/bacnet/local/objects/schedules/${room.scheduleID}`, {
      "special-events": special,
      "weekly-schedule": room.weekly,
      "object-name": room.scheduleName,
      "schedule-default": room.valueUnOccupied
    });
  }

  async function updateAllSchedules(api, rooms, label, active, conf) {
    if (logEnabled(conf, "eventsAddedInSchedules")) log("info", `${label}: creating events for ${rooms.length} rooms...`);
    const startedAt = Date.now();
    for (const room of rooms) {
      if (!active()) return;
      try {
        await updateRoomSchedule(api, room);
      } catch (error) {
        // Skip the room on iCal/HTTP error.
        log("error", `Error for room ${room.scheduleName}: ${error.message}`);
      }
    }
    if (logEnabled(conf, "eventTimeCreation")) log("info", `${label}: ${rooms.length} rooms processed in ${(Date.now() - startedAt) / 1000} s`);
  }

  async function updateScheduleAV(api, rooms, conf, label) {
    const offset = conf.scheduleAVInstanceOffset;
    if (logEnabled(conf, "scheduleAVUpdate")) log("info", `${label}: Updating scheduleAV...`);
    const read = await api.post("/services/bacnet/local/objects/read-property-multiple", {
      encode: "text",
      "property-references": rooms.map((room) => ({ type: "Schedule", instance: room.scheduleID, property: "presentValue" }))
    });

    const writes = [];
    for (const result of read.data.results) {
      const value = result.value;
      if (!value || String(value).includes("Null")) {
        log("warning", `${label}: Schedule ${result.instance} returns 0 or NULL`);
      } else if (String(value).includes("Unknown Object")) {
        log("warning", `${label}: Schedule ${result.instance} doesn't exist`);
      } else {
        const number = parseFloat(value);
        if (Number.isNaN(number)) {
          log("warning", `${label}: Schedule ${result.instance}: unexpected value "${value}"`);
          continue;
        }
        writes.push({ type: "analogValue", instance: offset + result.instance, property: "presentValue", value: number });
      }
    }

    if (writes.length) {
      await api.post("/services/bacnet/local/objects/write-property-multiple", { encode: "text", "property-references": writes });
    }
  }

  /** Run fn now and then every `seconds`, never overlapping, until the configuration is replaced. */
  function loop(name, seconds, active, fn) {
    (async () => {
      while (active()) {
        try {
          await fn();
        } catch (error) {
          log("error", `${name} failed: ${error.message}`);
        }
        await sleep(seconds * 1000);
      }
    })();
  }

  /** Stops any running loops, then starts the schedule synchronisation for the given configuration. */
  async function start({ icalToScheduleConf: conf, rooms: configuredRooms, deviceList, connections }) {
    const run = ++generation;
    const active = () => run === generation;
    const data = { icalToScheduleConf: conf, rooms: configuredRooms };

    const errors = validateRoomsSchedules(data, { deviceList, connections });
    if (errors.length) {
      log("error", `Rooms & Schedules not started: ${errors.map((error) => `${error.path}: ${error.message}`).join(" | ")}`);
      return;
    }
    if (!configuredRooms.length) return;

    const rooms = resolveRooms(data);
    const groups = new Map();
    for (const room of rooms) {
      if (!groups.has(room.connectionName)) groups.set(room.connectionName, { rooms: [], api: createApi(connections[room.connectionName]) });
      groups.get(room.connectionName).rooms.push(room);
    }

    try {
      for (const [name, group] of groups) {
        if (!active()) return;
        log("info", `${name}: creating ${group.rooms.length} schedules, scheduleAV and bindings...`);
        await setupSchedules(group.api, group.rooms, conf);
        await setupScheduleAV(group.api, group.rooms, conf);
        await setupBindings(group.api, group.rooms, conf, deviceList);
      }
    } catch (error) {
      log("error", `Rooms & Schedules startup failed: ${error.message}`);
      return;
    }

    log("info", `Ical events will be updated every ${formatDuration(conf.timeBetweenScheduleUpdate)}`);
    log("info", `ScheduleAV will be updated every ${formatDuration(conf.timeBetweenScheduleAVUpdate)}`);

    for (const [name, group] of groups) {
      loop(`${name} schedule update`, conf.timeBetweenScheduleUpdate, active, () => updateAllSchedules(group.api, group.rooms, name, active, conf));
      loop(`${name} scheduleAV update`, conf.timeBetweenScheduleAVUpdate, active, async () => {
        await sleep(1000);
        if (active()) await updateScheduleAV(group.api, group.rooms, conf, name);
      });
    }
  }

  function stop() {
    generation++;
  }

  return { start, stop };
}

module.exports = { createIcalScheduleService, buildSpecialEvents, tzParts };
