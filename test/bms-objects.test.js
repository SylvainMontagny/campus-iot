const test = require("node:test");
const assert = require("node:assert/strict");
const { listBmsObjects } = require("../src/bms-objects");

const REST = { ipAddress: "10.0.0.1", protocol: "restAPIBacnet", model: "distechControlsV2" };

test("lists values and schedules through the REST API", async () => {
  const client = async (_connection, _method, _path, data) => {
    if (data["property-references"][0].property === "objectList") {
      return { status: 200, data: { results: [{ type: "device", instance: 1, property: "objectList", value: [
        { type: "device", instance: 1 }, { type: "analogValue", instance: 2 }, { type: "analogInput", instance: 1 },
        { type: "binaryValue", instance: 4 }, { type: "schedule", instance: 7 }
      ] }] } };
    }
    return { status: 200, data: { results: [
      { type: "analogValue", instance: 2, property: "objectName", value: "Setpoint" },
      { type: "analogValue", instance: 2, property: "presentValue", value: 21.5 },
      { type: "schedule", instance: 7, property: "objectName", value: "Room A" },
      { type: "schedule", instance: 7, property: "exceptionSchedule", value: [{ date: "2030-03-07", events: [{ time: "08:00", value: 21 }] }] }
    ] } };
  };
  const result = await listBmsObjects(REST, { rest: { client } });
  assert.deepEqual(result.values.map((object) => `${object.type}:${object.instance}`), ["analogValue:2", "binaryValue:4"]);
  assert.equal(result.values[0].name, "Setpoint");
  assert.equal(result.values[0].presentValue, "21.5");
  assert.equal("description" in result.values[0], false);
  assert.equal(result.schedules.length, 1);
  assert.equal(result.schedules[0].name, "Room A");
  assert.equal(result.schedules[0].exceptionSchedule, "2030-03-07: 08:00 → 21");
});

test("reports REST authentication failures", async () => {
  const client = async () => ({ status: 401, data: "" });
  await assert.rejects(listBmsObjects(REST, { rest: { client } }), /credentials/);
});

test("lists values and schedules through native BACnet", async () => {
  const bacnet = require("@bacnet-js/client");
  const { ObjectType, PropertyIdentifier } = bacnet;
  const client = {
    async readProperty() {
      return { values: [
        { value: { type: ObjectType.DEVICE, instance: 5 } },
        { value: { type: ObjectType.BINARY_VALUE, instance: 3 } },
        { value: { type: ObjectType.ANALOG_INPUT, instance: 1 } },
        { value: { type: ObjectType.SCHEDULE, instance: 9 } }
      ] };
    },
    async readPropertyMultiple() {
      return { values: [
        { objectId: { type: ObjectType.BINARY_VALUE, instance: 3 }, values: [
          { property: { id: PropertyIdentifier.OBJECT_NAME }, value: [{ type: 7, value: "Fan" }] },
          { property: { id: PropertyIdentifier.PRESENT_VALUE }, value: [{ type: 9, value: 1 }] }
        ] },
        { objectId: { type: ObjectType.SCHEDULE, instance: 9 }, values: [
          { property: { id: PropertyIdentifier.OBJECT_NAME }, value: [{ type: 7, value: "Zone 1" }] },
          { property: { id: PropertyIdentifier.EXCEPTION_SCHEDULE }, value: [
            { date: { type: 10, value: new Date(2030, 2, 7) }, events: [{ time: { type: 11, value: new Date(2000, 0, 1, 8, 30) }, value: { type: 4, value: 21 } }, { time: { type: 11, value: new Date(2000, 0, 1, 18, 0) }, value: { type: 0, value: null } }], priority: { type: 2, value: 1 } }
          ] }
        ] }
      ] };
    }
  };
  const result = await listBmsObjects({ ipAddress: "10.0.0.1", protocol: "bacnet" }, { bacnet: { client } });
  assert.deepEqual(result.values, [{ type: "binaryValue", instance: 3, name: "Fan", presentValue: "1" }]);
  assert.equal(result.schedules.length, 1);
  assert.equal(result.schedules[0].exceptionSchedule, "2030-03-07 (Thu): 08:30 → 21, 18:00 → null (priority 1)");
});
