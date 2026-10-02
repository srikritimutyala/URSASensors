/**
 * Polar BLE (Bluetooth Low Energy) Manager
 *
 * Connects to Polar Heart Rate / HRV sensors (Polar H10, H9, Verity Sense, OH1, etc.)
 * using standard Bluetooth GATT Heart Rate Service (0x180D) and Battery Service (0x180F).
 */

export interface HeartRateMeasurement {
  heartRate: number; // BPM
  rrIntervals: number[]; // R-R intervals in milliseconds
  contactDetected?: boolean;
  energyExpended?: number;
  timestamp: number; // epoch ms (Date.now())
  performanceTimestamp: number; // performance.now()
}

export interface PolarDeviceInfo {
  name: string;
  id: string;
  connected: boolean;
  batteryLevel: number | null;
  lastMeasurement: HeartRateMeasurement | null;
}

export type MeasurementCallback = (data: HeartRateMeasurement) => void;
export type BatteryCallback = (batteryLevel: number) => void;
export type StatusCallback = (connected: boolean, deviceName: string) => void;

// Standard GATT UUIDs
const HEART_RATE_SERVICE_UUID = 0x180d;
const HEART_RATE_MEASUREMENT_UUID = 0x2a37;
const BATTERY_SERVICE_UUID = 0x180f;
const BATTERY_LEVEL_UUID = 0x2a19;
const DEVICE_INFO_SERVICE_UUID = 0x180a;

export class PolarBleManager {
  private device: any | null = null;
  private gattServer: any | null = null;
  private hrCharacteristic: any | null = null;
  private batteryCharacteristic: any | null = null;

  private isConnecting: boolean = false;
  private lastMeasurement: HeartRateMeasurement | null = null;
  private batteryLevel: number | null = null;

  private onMeasurementCallbacks: Set<MeasurementCallback> = new Set();
  private onBatteryCallbacks: Set<BatteryCallback> = new Set();
  private onStatusCallbacks: Set<StatusCallback> = new Set();
  private boundHandleDisconnection = this.handleDisconnection.bind(this);

  public get isConnected(): boolean {
    return !!(this.gattServer && this.gattServer.connected);
  }

  public get deviceName(): string {
    return this.device?.name || "Polar Device";
  }

  public get currentBattery(): number | null {
    return this.batteryLevel;
  }

  public get currentMeasurement(): HeartRateMeasurement | null {
    return this.lastMeasurement;
  }

  /**
   * Request and connect to a Polar sensor over Web Bluetooth
   */
  public async connect(acceptAll: boolean = false): Promise<boolean> {
    if (typeof window === "undefined") return false;

    const nav = navigator as any;
    if (!nav.bluetooth) {
      throw new Error("Web Bluetooth API is not available in this browser. Please use Chrome, Edge, or Opera.");
    }

    try {
      this.isConnecting = true;

      const supportedServices = [
        HEART_RATE_SERVICE_UUID,
        "heart_rate",
        "0000180d-0000-1000-8000-00805f9b34fb",
        BATTERY_SERVICE_UUID,
        "battery_service",
        "0000180f-0000-1000-8000-00805f9b34fb",
        DEVICE_INFO_SERVICE_UUID,
        "device_information",
        "0000180a-0000-1000-8000-00805f9b34fb",
      ];

      const requestOptions: any = acceptAll
        ? {
            acceptAllDevices: true,
            optionalServices: supportedServices,
          }
        : {
            // Include service filters and broad name prefixes so Polar H10/H9/Verity and standard HRMs
            // are discovered even if the 16-bit UUID isn't in the primary advertisement PDU.
            filters: [
              { services: [HEART_RATE_SERVICE_UUID] },
              { services: ["heart_rate"] },
              { services: ["0000180d-0000-1000-8000-00805f9b34fb"] },
              { namePrefix: "Polar" },
              { namePrefix: "polar" },
              { namePrefix: "H10" },
              { namePrefix: "H9" },
              { namePrefix: "Verity" },
              { namePrefix: "OH1" },
              { namePrefix: "HRM" },
              { namePrefix: "hrm" },
              { namePrefix: "Tickr" },
              { namePrefix: "TICKR" },
              { namePrefix: "CooSpo" },
              { namePrefix: "coospo" },
              { namePrefix: "Garmin" },
              { namePrefix: "garmin" },
              { namePrefix: "Wahoo" },
              { namePrefix: "wahoo" },
              { namePrefix: "Heart" },
              { namePrefix: "heart" },
              { namePrefix: "Sense" },
            ],
            optionalServices: supportedServices,
          };

      const device = await nav.bluetooth.requestDevice(requestOptions);

      if (!device) {
        this.isConnecting = false;
        return false;
      }

      this.device = device;
      console.log(`Connecting to Polar BLE device: "${device.name || "Unknown"}" (id: ${device.id})`);
      device.removeEventListener("gattserverdisconnected", this.boundHandleDisconnection);
      device.addEventListener("gattserverdisconnected", this.boundHandleDisconnection);

      // Connect to GATT Server with retry logic (helps with macOS/Chrome CoreBluetooth connection timing)
      let server: any = null;
      let lastGattErr: any = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt > 1) {
            console.log(`Retrying GATT connection to ${device.name || "device"} (attempt ${attempt}/3)...`);
            await new Promise((resolve) => setTimeout(resolve, 600));
          }
          server = await device.gatt.connect();
          if (server && server.connected) {
            break;
          }
        } catch (err: any) {
          lastGattErr = err;
          console.warn(`GATT connection attempt ${attempt} failed:`, err);
        }
      }

      if (!server || !server.connected) {
        throw lastGattErr || new Error("Failed to connect to Bluetooth GATT server.");
      }
      this.gattServer = server;

      // Get Heart Rate Service & Characteristic with resilient fallback
      let hrService: any = null;
      try {
        hrService = await server.getPrimaryService(HEART_RATE_SERVICE_UUID);
      } catch {
        try {
          hrService = await server.getPrimaryService("heart_rate");
        } catch {
          throw new Error(
            `Device "${device.name || "Bluetooth device"}" connected, but Heart Rate Service (0x180D) was not found. Please ensure this is an HRV / Heart Rate monitor.`
          );
        }
      }

      let hrChar: any = null;
      try {
        hrChar = await hrService.getCharacteristic(HEART_RATE_MEASUREMENT_UUID);
      } catch {
        try {
          hrChar = await hrService.getCharacteristic("heart_rate_measurement");
        } catch {
          throw new Error(
            `Heart Rate measurement characteristic (0x2A37) not found on device "${device.name || "Bluetooth device"}".`
          );
        }
      }
      this.hrCharacteristic = hrChar;

      // Start notifications for Heart Rate & RR intervals
      await hrChar.startNotifications();
      hrChar.addEventListener(
        "characteristicvaluechanged",
        this.handleHeartRateValueChanged.bind(this)
      );

      // Attempt to read Battery Service (optional, doesn't throw if unsupported)
      try {
        let batteryService: any = null;
        try {
          batteryService = await server.getPrimaryService(BATTERY_SERVICE_UUID);
        } catch {
          batteryService = await server.getPrimaryService("battery_service");
        }

        let batteryChar: any = null;
        try {
          batteryChar = await batteryService.getCharacteristic(BATTERY_LEVEL_UUID);
        } catch {
          batteryChar = await batteryService.getCharacteristic("battery_level");
        }
        this.batteryCharacteristic = batteryChar;

        const batteryVal = await batteryChar.readValue();
        if (batteryVal && batteryVal.byteLength > 0) {
          const level = batteryVal.getUint8(0);
          this.batteryLevel = level;
          this.notifyBattery(level);
        }

        // Subscribe to battery level changes if supported
        await batteryChar.startNotifications();
        batteryChar.addEventListener("characteristicvaluechanged", (e: any) => {
          if (e.target?.value && e.target.value.byteLength > 0) {
            const level = e.target.value.getUint8(0);
            this.batteryLevel = level;
            this.notifyBattery(level);
          }
        });
      } catch (err) {
        console.log("Polar battery service not available:", err);
      }

      this.notifyStatus(true, this.deviceName);
      this.isConnecting = false;
      return true;
    } catch (error: any) {
      this.isConnecting = false;
      console.error("Polar connection failed:", error);

      // Rethrow clean user cancellation without error transformation
      if (error?.name === "NotFoundError" || error?.message?.includes("User cancelled")) {
        throw error;
      }

      const msg = error?.message || "";
      if (
        error?.name === "NetworkError" ||
        msg.toLowerCase().includes("unsupported device") ||
        msg.toLowerCase().includes("connection failed")
      ) {
        const enhancedError = new Error(
          "Could not establish Bluetooth connection (Unsupported device / Connection rejected).\n\n" +
          "Troubleshooting:\n" +
          "1. Electrodes must be wet & strap worn: Polar H10 enters sleep mode if the strap is dry or not on your chest.\n" +
          "2. Disconnect from phone: Polar sensors only connect to 1 device at a time. Turn off Bluetooth on your phone or close Polar Beat/Flow.\n" +
          "3. Forget in Mac Bluetooth: If paired in macOS System Settings > Bluetooth, click 'Forget This Device'. Web Bluetooth requires a direct app connection.\n" +
          "4. Select the Heart Rate sensor: Make sure you select the BLE device broadcasting Heart Rate Service."
        );
        enhancedError.name = "PolarConnectionError";
        throw enhancedError;
      }

      throw error;
    }
  }

  /**
   * Disconnect from Polar device
   */
  public async disconnect(): Promise<void> {
    try {
      if (this.device) {
        this.device.removeEventListener("gattserverdisconnected", this.boundHandleDisconnection);
      }

      if (this.hrCharacteristic) {
        try {
          await this.hrCharacteristic.stopNotifications();
        } catch (e) {
          console.warn("Error stopping HR notifications:", e);
        }
        this.hrCharacteristic = null;
      }

      if (this.batteryCharacteristic) {
        try {
          await this.batteryCharacteristic.stopNotifications();
        } catch (e) {
          console.warn("Error stopping battery notifications:", e);
        }
        this.batteryCharacteristic = null;
      }

      if (this.gattServer && this.gattServer.connected) {
        this.gattServer.disconnect();
      }
    } finally {
      this.handleDisconnection();
    }
  }

  private handleDisconnection() {
    this.gattServer = null;
    this.hrCharacteristic = null;
    this.batteryCharacteristic = null;
    this.lastMeasurement = null;
    this.notifyStatus(false, this.deviceName);
  }

  /**
   * Parse standard Bluetooth SIG Heart Rate Measurement packet (0x2A37)
   */
  private handleHeartRateValueChanged(event: any) {
    const dataView: DataView | undefined = event.target?.value;
    if (!dataView || dataView.byteLength < 2) return;

    const flags = dataView.getUint8(0);
    const is16BitHR = (flags & 0x01) !== 0;
    const contactSupported = (flags & 0x04) !== 0;
    const contactDetected = contactSupported ? (flags & 0x02) !== 0 : undefined;
    const energyExpendedPresent = (flags & 0x08) !== 0;
    const rrIntervalsPresent = (flags & 0x10) !== 0;

    let offset = 1;
    let heartRate: number;

    if (is16BitHR) {
      heartRate = dataView.getUint16(offset, true); // little-endian
      offset += 2;
    } else {
      heartRate = dataView.getUint8(offset);
      offset += 1;
    }

    let energyExpended: number | undefined;
    if (energyExpendedPresent && offset + 1 < dataView.byteLength) {
      energyExpended = dataView.getUint16(offset, true);
      offset += 2;
    }

    const rrIntervals: number[] = [];
    if (rrIntervalsPresent) {
      while (offset + 1 < dataView.byteLength) {
        const rrRaw = dataView.getUint16(offset, true);
        offset += 2;
        // Standard Bluetooth unit: 1/1024 second.
        // Convert to milliseconds: (rrRaw / 1024) * 1000
        const rrMs = (rrRaw * 1000) / 1024;
        rrIntervals.push(Math.round(rrMs * 10) / 10);
      }
    }

    const measurement: HeartRateMeasurement = {
      heartRate,
      rrIntervals,
      contactDetected,
      energyExpended,
      timestamp: Date.now(),
      performanceTimestamp: performance.now(),
    };

    this.lastMeasurement = measurement;
    this.notifyMeasurement(measurement);
  }

  public onMeasurement(cb: MeasurementCallback): () => void {
    this.onMeasurementCallbacks.add(cb);
    return () => this.onMeasurementCallbacks.delete(cb);
  }

  public onBattery(cb: BatteryCallback): () => void {
    this.onBatteryCallbacks.add(cb);
    return () => this.onBatteryCallbacks.delete(cb);
  }

  public onStatus(cb: StatusCallback): () => void {
    this.onStatusCallbacks.add(cb);
    return () => this.onStatusCallbacks.delete(cb);
  }

  private notifyMeasurement(m: HeartRateMeasurement) {
    this.onMeasurementCallbacks.forEach((cb) => {
      try {
        cb(m);
      } catch (e) {
        console.error("Error in Polar onMeasurement callback:", e);
      }
    });
  }

  private notifyBattery(b: number) {
    this.onBatteryCallbacks.forEach((cb) => {
      try {
        cb(b);
      } catch (e) {
        console.error("Error in Polar onBattery callback:", e);
      }
    });
  }

  private notifyStatus(connected: boolean, name: string) {
    this.onStatusCallbacks.forEach((cb) => {
      try {
        cb(connected, name);
      } catch (e) {
        console.error("Error in Polar onStatus callback:", e);
      }
    });
  }
}

// Global singleton instance for easy cross-component access
export const polarBleManager = new PolarBleManager();
