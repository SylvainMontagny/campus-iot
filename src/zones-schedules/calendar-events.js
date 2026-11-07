// Keep the preview and schedule updates on the same occurrence and time-window rules.
function eventsInWindow(data, nbrDaysPreview, now = Date.now()) {
  const horizon = now + nbrDaysPreview * 86400000;
  const events = [];
  const text = (value) => (value && typeof value === "object" ? String(value.val ?? "") : String(value ?? ""));

  for (const event of Object.values(data)) {
    if (event.type !== "VEVENT") continue;
    const summary = text(event.summary);
    const description = text(event.description);
    const duration = event.end - event.start;
    const starts = event.rrule
      ? event.rrule.between(new Date(now - duration), new Date(horizon), true)
        .filter((date) => !(event.exdate && event.exdate[date.toISOString().slice(0, 10)]))
      : [event.start];

    for (const startDate of starts) {
      const start = new Date(startDate);
      const end = new Date(start.getTime() + duration);
      if (end.getTime() > now && start.getTime() < horizon) events.push({ start, end, summary, description });
    }
  }
  return events.sort((a, b) => a.start - b.start);
}

module.exports = { eventsInWindow };
