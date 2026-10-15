const axios = require("axios");
const https = require("node:https");
const ical = require("node-ical");
const { validateZonesSchedules, resolveZones, SCHEDULE_EVENTS } = require("./zones-config");
const { createNativeScheduleDriver } = require("./bacnet-schedule");

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

/** Fetch the zone iCal and return plain {start, end, summary, description} within the preview window. */
async function fetchEvents(zone) {
  const data = await ical.async.fromURL(zone.url);
  const now = Date.now();
  const horizon = now + zone.nbrDaysPreview * 86400000;
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

/** Build the "special-events" object for one zone. */
function buildSpecialEvents(zone, rawEvents, warn = () => {}) {
  const tz = zone.timeZone;
  let events = rawEvents.filter((event) => !zone.eventsToDiscard.some((name) => event.description.includes(name)));

  if (zone.groupEvents) {
    const byDay = new Map();
    for (const event of events) {
      const key = tzParts(event.start, tz).dateKey;
      const current = byDay.get(key);
      if (!current) byDay.set(key, { ...event, summaries: [event.summary] });
      else {
        current.summaries.push(event.summary);
        if (event.start < current.start) current.start = event.start;
        if (event.end > current.end) current.end = event.end;
      }
    }
    events = [...byDay.values()].map(({ summaries, ...event }) => ({ ...event, summary: summaries.join(", ") }));
  }

  const special = {};
  let eventID = 1;

  events.forEach((event, index) => {
    if (!zone.groupEvents) {
      const duration = (event.end - event.start) / 60000;
      if (duration < zone.minimumSlotDuration) {
        warn(`Zone ${zone.scheduleName}: event ${index} "${event.summary}" discarded (duration < ${zone.minimumSlotDuration} min).`);
        return;
      }
    }

    const originalDay = tzParts(event.start, tz);
    let startTime;
    let endTime;

    if (zone.groupEvents) {
      const start = new Date(event.start.getTime() - zone.timeOffsetBeforeStart * 60000);
      const end = new Date(event.end.getTime() - zone.timeOffsetBeforeEnd * 60000);
      const startParts = tzParts(start, tz);
      startTime = startParts.time;
      // The offset may push the start into the previous day.
      if (startParts.dateKey < originalDay.dateKey) {
        startTime = "00:00:00";
        warn(`Zone ${zone.scheduleName}: event ${index} "${event.summary}" clamped to midnight.`);
      }
      endTime = tzParts(end, tz).time;
      if (startTime >= endTime) {
        warn(`Zone ${zone.scheduleName}: event ${index} "${event.summary}" discarded (start >= end).`);
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
        1: { time: startTime, value: zone.valueOccupied, key: "1" },
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

  async function setupSchedules(api, zones, conf) {
    const [min, max] = conf.scheduleInstanceRange;
    const deletions = [];
    for (let i = min; i <= max; i++) {
      deletions.push({ method: "DELETE", url: `/api/rest/v2/services/bacnet/local/objects/schedules/${i}` });
    }
    await batch(api, deletions);

    await batch(api, zones.map((zone) => ({
      method: "POST",
      url: "/api/rest/v2/services/bacnet/local/objects/add",
      body: { "object-type": "schedule", "instance-number": zone.scheduleID, name: zone.scheduleName }
    })));

    await batch(api, zones.map((zone) => ({
      method: "POST",
      url: `/api/rest/v2/services/bacnet/local/objects/schedules/${zone.scheduleID}`,
      body: { "schedule-default": 19, description: `Zone ${zone.scheduleName}` }
    })));
  }

  async function setupScheduleAV(api, zones, conf) {
    const [min, max] = conf.scheduleInstanceRange;
    const offset = conf.scheduleAVInstanceOffset;
    const deletions = [];
    for (let i = min; i <= max; i++) {
      deletions.push({ method: "DELETE", url: `/api/rest/v2/services/bacnet/local/objects/analog-values/${i + offset}` });
    }
    await batch(api, deletions);

    await batch(api, zones.map((zone) => ({
      method: "POST",
      url: "/api/rest/v2/services/bacnet/local/objects/add",
      body: { "object-type": "AnalogValue", "instance-number": zone.scheduleID + offset, name: `scheduleAV-${zone.scheduleName}` }
    })));

    await batch(api, zones.map((zone) => ({
      method: "POST",
      url: `/api/rest/v2/services/bacnet/local/objects/analog-values/${zone.scheduleID + offset}`,
      body: { "default-value": zone.valueOccupied }
    })));
  }

  async function setupBindings(api, zones, conf, deviceProfiles) {
    const existing = (await api.get("/services/events/bindings")).data;
    if (existing && typeof existing === "object") {
      await batch(api, Object.keys(existing).map((name) => ({
        method: "DELETE",
        url: `/api/rest/v2/services/events/bindings/${name}`
      })));
    }

    const offset = conf.scheduleAVInstanceOffset;
    const requests = [];
    for (const zone of zones) {
      for (const [profileName, device] of Object.entries(zone.devices)) {
        const bacnet = deviceProfiles[profileName].bacnet;
        const objectOffset = bacnet.objects[device.AVToBindName].instanceNum;
        for (const number of device.deviceNums) {
          const avInstance = bacnet.instanceRangeAV * number + objectOffset + bacnet.offsetAV;
          requests.push({
            method: "POST",
            url: `/api/rest/v2/services/events/bindings/binding_scheduleAV-${zone.scheduleName}_${device.AVToBindName}-${avInstance}`,
            body: {
              type: "ControlElement",
              "element-a": `/services/bacnet/local/objects/analog-values/${offset + zone.scheduleID}`,
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

  async function updateZoneSchedule(driver, zone) {
    const special = buildSpecialEvents(zone, await fetchEvents(zone), (message) => log("warning", message));
    await driver.updateZoneSchedule(zone, special);
  }

  async function updateAllSchedules(driver, zones, label, active, conf) {
    if (logEnabled(conf, "eventsAddedInSchedules")) log("info", `${label}: creating events for ${zones.length} zones (${zones.map((zone) => zone.scheduleName).join(", ")})...`);
    const startedAt = Date.now();
    for (const zone of zones) {
      if (!active()) return;
      try {
        await updateZoneSchedule(driver, zone);
      } catch (error) {
        // Skip the zone on iCal/HTTP error.
        log("error", `Error for zone ${zone.scheduleName}: ${error.message}`);
      }
    }
    if (logEnabled(conf, "eventTimeCreation")) log("info", `${label}: ${zones.length} zones processed in ${(Date.now() - startedAt) / 1000} s`);
  }

  async function updateScheduleAV(api, zones, conf, label) {
    const offset = conf.scheduleAVInstanceOffset;
    if (logEnabled(conf, "scheduleAVUpdate")) log("info", `${label}: Updating scheduleAV...`);
    const read = await api.post("/services/bacnet/local/objects/read-property-multiple", {
      encode: "text",
      "property-references": zones.map((zone) => ({ type: "Schedule", instance: zone.scheduleID, property: "presentValue" }))
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

  function createRestDriver(api) {
    return {
      setupSchedules: (zones, conf) => setupSchedules(api, zones, conf),
      setupScheduleAV: (zones, conf) => setupScheduleAV(api, zones, conf),
      setupBindings: (zones, conf, deviceProfiles) => setupBindings(api, zones, conf, deviceProfiles),
      updateScheduleAV: (zones, conf, label) => updateScheduleAV(api, zones, conf, label),
      updateZoneSchedule: (zone, special) => api.post(`/services/bacnet/local/objects/schedules/${zone.scheduleID}`, {
        "special-events": special,
        "weekly-schedule": zone.weekly,
        "object-name": zone.scheduleName,
        "schedule-default": zone.valueUnOccupied
      })
    };
  }

  // The BMS protocol of the connection decides how every BMS action is carried out.
  function createDriver(connection, deviceProfiles) {
    return connection.protocol === "bacnet"
      ? createNativeScheduleDriver(connection, { log, deviceProfiles })
      : createRestDriver(createApi(connection));
  }

  /** Stops any running loops, then starts the schedule synchronisation for the given configuration. */
  async function start({ icalToScheduleConf: conf, scheduleEventsConf, zones: configuredZones, deviceProfiles, connections }) {
    const run = ++generation;
    const active = () => run === generation;
    const data = { icalToScheduleConf: conf, scheduleEventsConf, zones: configuredZones };

    const errors = validateZonesSchedules(data, { deviceProfiles, connections });
    if (errors.length) {
      log("error", `Zones & Schedules not started: ${errors.map((error) => `${error.path}: ${error.message}`).join(" | ")}`);
      return;
    }
    if (!configuredZones.length) return;

    // Groups are per BMS connection and per configuration.
    const groups = new Map();
    for (const zone of resolveZones(data)) {
      const eventsOnly = zone.configuration === SCHEDULE_EVENTS;
      const key = `${eventsOnly ? "events" : "ical"}|${zone.connectionName}`;
      if (!groups.has(key)) {
        groups.set(key, {
          name: `${zone.connectionName} - ${connections[zone.connectionName]?.protocol === "bacnet" ? "BACnet" : "Rest API"}`, eventsOnly, zones: [],
          conf: eventsOnly ? data.scheduleEventsConf : conf,
          driver: createDriver(connections[zone.connectionName], deviceProfiles)
        });
      }
      groups.get(key).zones.push(zone);
    }

    try {
      for (const group of groups.values()) {
        if (!active()) return;
        // Zones adding events to existing BACnet schedules need no schedule, scheduleAV or binding setup.
        if (group.eventsOnly) continue;
        log("info", `${group.name}: creating ${group.zones.length} schedules${group.driver.setupScheduleAV ? ", scheduleAV" : ""} and bindings...`);
        await group.driver.setupSchedules(group.zones, group.conf);
        if (group.driver.setupScheduleAV) await group.driver.setupScheduleAV(group.zones, group.conf);
        await group.driver.setupBindings(group.zones, group.conf, deviceProfiles);
      }
    } catch (error) {
      log("error", `Zones & Schedules startup failed: ${error.message}`);
      return;
    }

    const updateEvery = (group) => (group.eventsOnly ? data.scheduleEventsConf : conf).timeBetweenScheduleUpdate;
    if ([...groups.values()].some((group) => !group.eventsOnly && group.driver.updateScheduleAV)) {
      log("info", `Ical events will be updated every ${formatDuration(conf.timeBetweenScheduleUpdate)}`);
      log("info", `ScheduleAV will be updated every ${formatDuration(conf.timeBetweenScheduleAVUpdate)}`);
    } else if ([...groups.values()].some((group) => !group.eventsOnly)) {
      log("info", `Ical events will be updated every ${formatDuration(conf.timeBetweenScheduleUpdate)}`);
    }
    if ([...groups.values()].some((group) => group.eventsOnly)) {
      log("info", `Events added to BACnet schedules will be updated every ${formatDuration(data.scheduleEventsConf.timeBetweenScheduleUpdate)}`);
    }

    for (const group of groups.values()) {
      const label = group.eventsOnly ? `${group.name} (events)` : group.name;
      loop(`${label} schedule update`, updateEvery(group), active, () => updateAllSchedules(group.driver, group.zones, label, active, group.conf));
      if (group.eventsOnly || !group.driver.updateScheduleAV) continue;
      loop(`${label} scheduleAV update`, conf.timeBetweenScheduleAVUpdate, active, async () => {
        await sleep(1000);
        if (active()) await group.driver.updateScheduleAV(group.zones, conf, label, deviceProfiles);
      });
    }
  }

  function stop() {
    generation++;
  }

  return { start, stop };
}

module.exports = { createIcalScheduleService, buildSpecialEvents, tzParts };
