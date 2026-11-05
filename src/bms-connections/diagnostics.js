// BMS diagnostics: records a device snapshot after a controller has processed uplink or downlink values.
function logDeviceObject(log, device, dataDirection) {
  const label = dataDirection === "uplink" ? "uplink" : "downlink";
  log("output", `Device object after ${label} process:\n${JSON.stringify(device, null, 2)}`, structuredClone(device), dataDirection === "uplink" ? "deviceUplink" : "deviceDownlink");
}

module.exports = { logDeviceObject };
