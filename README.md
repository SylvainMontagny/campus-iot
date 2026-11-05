# Campus-IoT, an open-source platform for smart building management

Campus-IoT is a web application with three main features:
1. It writes your **LoRaWAN end-device** payload data to **BACnet objects** in a BMS. It can also read **BACnet object** values and send them to LoRaWAN end-devices. To learn more, see the [webinar on this topic](https://youtu.be/LRaT3Jc7xrs?si=O3qf1RE9En45UXKb).

![LoRaBAC](images/lorabac.png)

2. It configures **BACnet schedule objects** from an **iCal calendar**. Since many BACnet controllers have a static weekly schedule, Campus IoT provides an easy way to write events directly to a schedule object.

![LoRaBAC](images/intermitence-bacnet.png)

3. It controls **LoRaWAN actuators** using events from an **iCal calendar**. For example, it can send a thermostatic valve's temperature setpoint according to room occupancy.

![LoRaBAC](images/ical-to-schedule.png)


## **1. Overview**
### **1.1. Key Features**
Campus IoT acts as a bridge between **LoRaWAN end-devices** and **BACnet controllers**, making it ideal for **smart building applications**.

#### **Key Features for the LoRaWAN to BACnet interface**

- **Universal Compatibility:**
  - [x] Works with **all LoRaWAN end-devices** and **gateways**.
  - [x] Supports **ChirpStack**, **Actility**, and **The Things Stack** (The Things Network / The Things Industries) Network Servers.
  - [x] Integrates with **all BACnet controllers** using native BACnet protocols (and/or Rest API when using **Distech-Controls controllers**).

- **Bidirectional Communication:**
  - [x] **Uplink:** Writes LoRaWAN payloads to specific BACnet objects.
  - [x] **Downlink:** Writes BACnet objects to specific LoRaWAN payload.

- **Proven Use Cases:**
  - [x] Thermostatic valves
  - [x] Temperature and humidity sensors
  - [x] Air quality sensors
  - [x] Current monitoring sensors
  - [x] Pilot wired electric heater controller

#### **Key Features for controlling LoRaWAN actuators with an iCal calendar**
  - [x] Dynamically creates a schedule object on the BMS and adds special events based on the iCal calendar.
  - [x] Works with any URL that provides an iCal calendar.

#### **Key Features for configuring BACnet schedule objects from an iCal calendar**
  - [x] Writes special events to a remote BACnet schedule object based on an iCal calendar.

For the last two features, iCal calendar handling is **highly configurable:**
  - [x] **Schedule output:** configure the value when the zone is occupied/unoccupied.
  - [x] **Anticipation and inertia:** when you need to heat a room before its occupation.
  - [x] **Merge:** if you want to provide a merged time slot of all daily event.
  - [x] **Discard:** if you want to discard specific event in the ical agenda.
  - [x] **Weekly event:** if you want to add a weekly event configuration on top of the special event.


### **1.2. What Makes Campus IoT Unique?**
Campus IoT is designed with a **different approach** compared to other LoRaWAN-BACnet interfaces. Here’s why it stands out:

1. **BACnet Client Architecture:**
   - Unlike most interfaces that act as **BACnet servers**, LoRaBAC operates as a **BACnet client**. It only interacts with the controller when a LoRaWAN payload is received, reducing unnecessary traffic.

2. **Flexible Deployment:**
   - LoRaBAC can be installed **anywhere**:
     - On the **LoRaWAN Gateway**
     - On any industrial PC within the **local network**
     - Directly on the **BMS**

3. **Open Source and Free:**
   - LoRaBAC is **free to use** and **open-source** under the **MIT License**, offering full transparency and customization.

### **1.3. Quick Start with Docker:**
A pre-configured **Node-RED Docker image** is available on [Docker Hub](https://hub.docker.com/r/montagny/node-red/tags). It includes all required packages for easy deployment.


### **1.4. Support**
For support with LoRaWAN or Campus IoT, please refer to the following resources or [contact us](https://www.univ-smb.fr/lorawan/en/contact/).

:tv: Webinar Replay: [LoRaWAN and BACnet interfaces for Smart Building]()

:notebook: Free ebook:[LoRaWAN for beginers books](https://www.univ-smb.fr/lorawan/en/free-book/)

:tv: E-learning platform: [LoRaWAN for beginers videos](https://www.udemy.com/course/lora-lorawan-internet-of-things/?referralCode=21DED0F1021F4E261955)

:tv: E-learning platform for Advanced users: [LoRaWAN for Advanced users videos](https://www.udemy.com/course/lorawan-for-advanced-users/?referralCode=BA4A670560916E1AED77)

:bulb: 2 days training sessions: [LoRaWAN and IoT Training](https://www.univ-smb.fr/lorawan/avada_portfolio/formation-distanciel/)



## **2. Prerequisites**
### **2.1. LoRaWAN End-Device**
To use Campus IoT you will need:
- A LoRaWAN **Network Server** (ChirpStack, TTN or Actility).
- The device **LoRaWAN payload decoder** (for uplink).
- The device **LoRaWAN payload encoder** (for downlink, if needed).

Payload decoders and encoders should be provided by your device manufacturer.


#### **LoRaWAN device name convention**
Campus IoT automatically assigns LoRaWAN payloads to BACnet objects based on the device number (NUM) in the **LoRaWAN device name**.

Use the following rules when naming LoRaWAN devices:
  1. **End each device name with a hyphen and a number (NUM).**
  2. NUM must be greater than 0.

Good examples: mclimate-vicki-1, micropelt-mlr003-3, nexelec-flow-54, test-25, myDevice-36, my_Device-69.

Wrong examples: 
- mclimate-vicki (no number)
- mclimate-vicki-0 (NUM cannot be 0), 
- mclimate-vicki-one (not a number at the end),
- mclimate vicki-1 (contains a space).



### **2.2. MQTT Broker**
Campus IoT relies on an **MQTT broker** for communication. You can use:
- The built-in MQTT broker provided by **ChirpStack**, **Actility**, or **The Things Stack**.
- Your own **custom MQTT broker**.

### **2.3. BACnet controller**
Campus IoT reads from and writes to an existing BACnet controller. If you don't have one, we provide a fully featured BACnet server that supports all BACnet services, with no limit on the number of objects.


## **3. Getting Started**
Campus IoT needs to run on the network host to be able to use the "who is" command for network discovery.

1. Run the following command on any hardware where docker is installed:
```bash
docker run -d \
  --name campus-iot \
  --network host \
  --restart unless-stopped \
  montagny/campus-iot:latest
```
2. Open <http://localhost:3000>

Alternatively, you can run this application directly with npm:

```powershell
npm install
npm start
```


## **4. Campus IoT configuration**
The complete Campus IoT configuration involves four steps:
1. MQTT connection
2. BMS connections
3. LoRaWAN To BACnet configuration
4. Zones & Schedules configuration

This section covers only the first two parts: **"MQTT connections"** and **"BMS connections"**. **"LoRaWAN To BACnet"** and **"Zones & Schedules"** are optional and depend on your use case. See the corresponding sections for more information.


### **4.1 Import/Export configuration**
If you have a ready to use configuration, use the "Import CONF" button. Your configuration will automatically apply after saving.


### **4.2 MQTT connections**
Campus IoT embeds a MQTT client (pub/sub). You need to provide:
- MQTT broker address/port
- Login
- Password
- Topic

MQTT connection settings are stored in `/data/mqtt-connections.json`

### **4.3 BMS connections**
Campus IoT is a BACnet client that reads from and writes to a BMS. Configure the BMS connection and the protocol to use. A Who-Is network discovery feature is available to make configuration easier. Provide:
- A connection name for this BMS
- The BMS IP address on the local network
- The protocol to use (BACnet by default; a REST API is available on some BMSs)

Press the Test button to check the connection, then save your configuration.

Use the "Get all Object" button to read all BACnet objects on the BMS.

BMS connections settings are stored in `/data/bms-connections.json`

## **5. LoRaWAN To BACnet configuration**
The LoRaWAN-to-BACnet process uses device profiles. For example, if your use case includes 200 thermostatic valves and 300 temperature sensors, configure two device profiles: one for the valves and one for the sensors.

LoRaWAN to BACnet configuration settings are stored in `/data/device-profiles.json`


#### **5.1. Device profile configuration:**
Device profile configuration has two steps. Most settings are self-explanatory. Click the tooltip icon (?) for more information about a specific field.
  1. Device profile configuration 
  2. Mapping between LoRaWAN payload and BACnet objects. 

#### **Instance Num configuration**
Campus IoT automatically assigns LoRaWAN payloads to BACnet objects based on the device number (NUM) in the LoRaWAN device name (xxxxx-NUM). Manual assignment is optional.
* **First AV instance number**: The starting instance number for Analog Value objects for this device profile.
* **First BV instance number**: The starting instance number for Binary Value objects for this device profile.
* **Number of AV for each device**: The number of Analog Value instances allocated to each device for this profile.
* **Number of BV for each device**: The number of Binary Value instances allocated to each device for this profile.

For example, the device **xxxxx-NUM** will read from and write to BACnet objects using this calculation:
**First AV instance number** + (**Number of AV for each device** * **NUM**).

Where **NUM** is the device number. 

#### **Uplink or downlink**
Mappings between LoRaWAN payloads and BACnet objects have two possible directions:
* **Uplink** means a mapping between a LoRaWAN payload and BACnet objects.
* **Downlink** means a mapping between a BACnet object and a LoRaWAN payload.

#### **Downlink strategies**
Please refer to the Appendix to know more about the downlink strategies proposed.


## **6. Zones & Schedules configuration**
Depending on your use case, configure this section in one of two ways:
1. Use an iCal calendar to populate a BACnet schedule object.
2. Use an iCal calendar to populate a BACnet schedule object and control a LoRaWAN end-device's downlink.

Use case 1 is for an existing BACnet schedule object on the BMS that you want to populate with events from an iCal calendar. The calendar can represent room or building occupancy, depending on what the BMS controls. In this case, Campus IoT fills the existing schedule object with special events from the calendar.

Use case 2 is for a LoRaWAN actuator, such as a thermostatic valve. Campus IoT:
- Dynamically creates a BACnet schedule object.
- Fills the schedule with special events from an iCal calendar.
- Links the schedule output to the downlink payload for the LoRaWAN end-device.
- Applies the downlink strategy to request a downlink from the LoRaWAN network server.




## APPENDIX A: **Downlink strategies**
Mapping LoRaWAN uplink payloads to BACnet objects is straightforward. Sending downlinks from BACnet objects to LoRaWAN end-devices is more challenging because it requires a strategy that defines when and how to send each downlink.

The LoRaBAC application currently provides four downlink strategies that cover most use cases.

### A.1. The **Compare with the following BACnet uplink object** strategy
On each uplink, the BACnet object value is compared to the BACnet object configured. 
* If the values are different, the object value is sent to the device with a downlink message.
* If the values are the same, no action is taken.

**Use case:** This strategy is useful with thermostatic valves that send their actual **setpoint**. Before sending a downlink, the setpoint computed by the BMS is compared with the valve's setpoint. If the values differ, the new setpoint is sent to the LoRaWAN valve.

### A.2. The **Compare with the following BACnet uplink object within range** strategy
On each uplink, the BACnet object value is compared to the BACnet object configured. 
* If the values are within the configured margin (range), no action is taken.
* If the values differ by more than the configured margin, a downlink is scheduled.

**Use case:** This strategy is useful with thermostatic valves that send the **room temperature measured by the valve**. If an external temperature sensor provides the **real room temperature**, that value can be sent to the valve whenever it differs from the temperature measured by the valve.

To reduce the number of downlinks, you may want to skip a downlink when the two temperatures are close. For example, if the difference is only 0.2°C, you may not need to update the valve. Set a range so that a downlink is sent only when the difference exceeds that range.



### A.3. The **On change on BMS** strategy
On each uplink (or polling time for class C end-devices), the BACnet object value is compared to its previous value (from the previous downlink). 
* If the values are different, a downlink is scheduled.
* If the values are the same, no action is taken.

**Use case:** This strategy is useful with thermostatic valves that do not send their setpoint, or with Class C end-devices that do not regularly send uplinks. Campus IoT tracks the last value sent to the LoRaWAN device and sends a downlink when the BACnet object value changes.

### A.4. The **On change on BMS within range** strategy
On each uplink (or polling time for class C end-devices), the BACnet object value is compared to its previous value (from the previous downlink).
* If the values are within the configured margin (range), no action is taken.
* If the values differ by more than the configured margin, a downlink is scheduled.

**Use case:** This strategy is useful with thermostatic valves that do not send their setpoint, or with Class C end-devices that do not regularly send uplinks. Campus IoT tracks the last value sent to the LoRaWAN device and sends a downlink only when the BACnet object value differs from the last value by more than the configured margin.

## APPENDIX B: **Specific information about the Network Server**
Depending on the LoRaWAN Network Server, there might be some specific configurations.

### B.1. Details for Actility (ThingPark):
When using downlinks, ThingPark needs information to retrieve the payload encoder. In ThingPark, payload decoders are called drivers and have three identifiers: pID, mID, and ver.

### B.2. Details for ChirpStack:
For downlinks and the "Flush Downlink Queue" capability, LoRaBAC uses the ChirpStack gRPC API to flush the queue. Therefore, you need to provide an API key generated by ChirpStack.
