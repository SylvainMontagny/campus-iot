// BMS connection service: exposes controller connection, object, discovery, and profile operations to the HTTP API.
module.exports = {
  ...require("./connection-test"),
  ...require("./objects"),
  ...require("./adapters/bacnet/discovery"),
  ...require("./profile-objects")
};
