import { saveAs } from "file-saver";
import type { HeartRateMeasurement } from "./polarBle";

/**
 * Robust cross-browser file download trigger that circumvents browser popup/gesture blocks
 */
export function triggerBrowserDownload(blob: Blob, filename: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", filename);
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      try {
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      } catch {}
    }, 1500);
    return true;
  } catch (e) {
    console.warn("Direct download failed, falling back to saveAs:", e);
    try {
      saveAs(blob, filename);
      return true;
    } catch (saveAsErr) {
      console.error("saveAs also failed:", saveAsErr);
      return false;
    }
  }
}

export interface HrvRecord {
  sessionId: string;
  timestamp: string;
  elapsedS: number;
  heartRate: number;
  rrIntervalMs: number;
  rmssd: number;
  sdnn: number;
  pnn50: number;
  state: string;
}

export type EegRecord = (number | string)[];

export interface FocusRecord {
  sessionId: string;
  timestamp: string;
  elapsedS: number;
  focusIndex: number;
  state: string;
}

export interface HrvMetrics {
  heartRate: number;
  lastRR: number;
  rmssd: number;
  sdnn: number;
  pnn50: number;
  state: string;
}

export interface FocusMetrics {
  focusIndex: number;
  state: string;
}

// FFT implementation for Focus Index (Beta / (Alpha + Theta))
function computeFFTMagnitudes(input: Float32Array): Float32Array {
  const n = input.length;
  const real = new Float32Array(input);
  const imag = new Float32Array(n);

  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
    let k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI) / len;
    const wStepR = Math.cos(angle);
    const wStepI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < half; k++) {
        const uR = real[i + k];
        const uI = imag[i + k];
        const vR = real[i + k + half] * wr - imag[i + k + half] * wi;
        const vI = real[i + k + half] * wi + imag[i + k + half] * wr;
        real[i + k] = uR + vR;
        imag[i + k] = uI + vI;
        real[i + k + half] = uR - vR;
        imag[i + k + half] = uI - vI;
        const nextWr = wr * wStepR - wi * wStepI;
        wi = wr * wStepI + wi * wStepR;
        wr = nextWr;
      }
    }
  }

  const mags = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    mags[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / (n / 2);
  }
  return mags;
}

export class SessionMetricsManager {
  private sessionId: string = "";
  private isActive: boolean = false;

  // HRV tracking
  private rrHistory: number[] = [];
  private hrvRecords: HrvRecord[] = [];
  private lastHrvLogElapsed: number = -1;

  // ECG real-time R-peak detection fallback
  private ecgBuffer: number[] = [];
  private lastEcgPeakSample: number = -1;
  private totalEcgSamples: number = 0;

  // EEG raw channel data tracking
  private eegRecords: (number | string)[][] = [];
  private eegHeader: string[] = ["Counter", "Channel1", "Channel2", "Channel3"];

  // Legacy Focus Index tracking (kept for compatibility)
  private eegBuffer: number[] = [];
  private focusRecords: FocusRecord[] = [];
  private lastFocusLogElapsed: number = -1;

  public get isRecording(): boolean {
    return this.isActive;
  }

  public get currentSessionId(): string {
    return this.sessionId;
  }

  public get hrvRecordCount(): number {
    return this.hrvRecords.length;
  }

  public get eegRecordCount(): number {
    return this.eegRecords.length;
  }

  public get focusRecordCount(): number {
    return this.eegRecords.length;
  }

  /**
   * Start a new recording session
   */
  public startSession(sessionId?: string): string {
    const now = new Date();
    this.sessionId = sessionId || `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
    this.isActive = true;

    this.rrHistory = [];
    this.hrvRecords = [];
    this.lastHrvLogElapsed = -1;

    this.ecgBuffer = [];
    this.lastEcgPeakSample = -1;
    this.totalEcgSamples = 0;

    this.eegRecords = [];
    this.eegHeader = [];
    this.eegBuffer = [];
    this.focusRecords = [];
    this.lastFocusLogElapsed = -1;

    return this.sessionId;
  }

  /**
   * Process incoming measurement from Polar BLE (hardware R-R intervals)
   */
  public processPolarMeasurement(
    measurement: HeartRateMeasurement,
    elapsedSeconds: number
  ): HrvMetrics | null {
    if (!this.isActive) return null;

    const isoTimestamp = new Date(measurement.timestamp || Date.now()).toISOString();
    const intervals = measurement.rrIntervals || [];

    if (intervals.length > 0) {
      for (const rr of intervals) {
        if (rr >= 300 && rr <= 2000) {
          this.rrHistory.push(rr);
          if (this.rrHistory.length > 30) this.rrHistory.shift();

          const metrics = this.computeHrvMetrics(this.rrHistory, measurement.heartRate);
          if (metrics) {
            this.hrvRecords.push({
              sessionId: this.sessionId,
              timestamp: isoTimestamp,
              elapsedS: +elapsedSeconds.toFixed(3),
              heartRate: metrics.heartRate,
              rrIntervalMs: +rr.toFixed(1),
              rmssd: metrics.rmssd,
              sdnn: metrics.sdnn,
              pnn50: metrics.pnn50,
              state: metrics.state,
            });
            this.lastHrvLogElapsed = elapsedSeconds;
          }
        }
      }
    } else if (
      measurement.heartRate > 0 &&
      (elapsedSeconds - this.lastHrvLogElapsed >= 1.0 || this.lastHrvLogElapsed < 0)
    ) {
      // Periodic fallback if no explicit RR in packet
      const estRR = Math.round(60000 / measurement.heartRate);
      this.rrHistory.push(estRR);
      if (this.rrHistory.length > 30) this.rrHistory.shift();
      const metrics = this.computeHrvMetrics(this.rrHistory, measurement.heartRate);
      if (metrics) {
        this.hrvRecords.push({
          sessionId: this.sessionId,
          timestamp: isoTimestamp,
          elapsedS: +elapsedSeconds.toFixed(3),
          heartRate: metrics.heartRate,
          rrIntervalMs: metrics.lastRR,
          rmssd: metrics.rmssd,
          sdnn: metrics.sdnn,
          pnn50: metrics.pnn50,
          state: metrics.state,
        });
        this.lastHrvLogElapsed = elapsedSeconds;
      }
    }

    return this.computeHrvMetrics(this.rrHistory, measurement.heartRate);
  }

  /**
   * Process a biopotential ECG sample (real-time R-peak detection fallback)
   */
  public processEcgSample(
    sampleValue: number,
    elapsedSeconds: number,
    sampleRate: number = 500
  ): HrvMetrics | null {
    if (!this.isActive) return null;

    this.totalEcgSamples += 1;
    this.ecgBuffer.push(sampleValue);
    if (this.ecgBuffer.length > sampleRate * 4) {
      this.ecgBuffer.shift();
    }

    // Run peak detection every 0.25s once buffer is primed
    if (this.totalEcgSamples % Math.floor(sampleRate / 4) === 0 && this.ecgBuffer.length >= sampleRate * 2) {
      const window = this.ecgBuffer;
      const n = window.length;
      let sumSq = 0;
      const diffs: number[] = new Array(n - 2);

      for (let i = 2; i < n; i++) {
        const d = window[i] - window[i - 2];
        diffs[i - 2] = d * d;
        sumSq += diffs[i - 2];
      }

      const meanSq = sumSq / Math.max(1, diffs.length);
      const minDistance = Math.floor(sampleRate * 0.35); // Max ~170 BPM
      const threshold = meanSq * 2.5;

      const bufferStartSample = this.totalEcgSamples - n;

      for (let i = 1; i < diffs.length - 1; i++) {
        if (
          diffs[i] > threshold &&
          diffs[i] > diffs[i - 1] &&
          diffs[i] > diffs[i + 1]
        ) {
          const absPeak = bufferStartSample + i;
          if (absPeak - this.lastEcgPeakSample >= minDistance) {
            if (this.lastEcgPeakSample > 0) {
              const rrMs = ((absPeak - this.lastEcgPeakSample) / sampleRate) * 1000;
              if (rrMs >= 300 && rrMs <= 2000) {
                this.rrHistory.push(+rrMs.toFixed(1));
                if (this.rrHistory.length > 30) this.rrHistory.shift();

                const metrics = this.computeHrvMetrics(this.rrHistory);
                if (metrics) {
                  this.hrvRecords.push({
                    sessionId: this.sessionId,
                    timestamp: new Date().toISOString(),
                    elapsedS: +elapsedSeconds.toFixed(3),
                    heartRate: metrics.heartRate,
                    rrIntervalMs: +rrMs.toFixed(1),
                    rmssd: metrics.rmssd,
                    sdnn: metrics.sdnn,
                    pnn50: metrics.pnn50,
                    state: metrics.state,
                  });
                  this.lastHrvLogElapsed = elapsedSeconds;
                }
              }
            }
            this.lastEcgPeakSample = absPeak;
          }
        }
      }
    }

    return this.computeHrvMetrics(this.rrHistory);
  }

  /**
   * Record raw EEG sample with Counter and actual channel readings
   */
  public recordEegSample(
    counter: number,
    channelValues: number[],
    channelLabels?: string[]
  ): void {
    if (!this.isActive) return;

    if (this.eegHeader.length === 0) {
      if (channelLabels && channelLabels.length === channelValues.length) {
        this.eegHeader = ["Counter", ...channelLabels];
      } else {
        this.eegHeader = ["Counter", ...channelValues.map((_, i) => `Channel${i + 1}`)];
      }
    }

    this.eegRecords.push([counter, ...channelValues]);
  }

  /**
   * Backwards compatible processEegSample supporting both new channel arrays and legacy callers
   */
  public processEegSample(
    sampleValueOrCounter: number,
    elapsedSecondsOrChannels?: number | number[],
    sampleRateOrLabels?: number | string[]
  ): FocusMetrics | null {
    if (Array.isArray(elapsedSecondsOrChannels)) {
      this.recordEegSample(
        sampleValueOrCounter,
        elapsedSecondsOrChannels,
        Array.isArray(sampleRateOrLabels) ? sampleRateOrLabels : undefined
      );
      return null;
    }
    return null;
  }

  /**
   * Compute standard time-domain HRV metrics from R-R list
   */
  public computeHrvMetrics(rrList: number[], fallbackBpm?: number): HrvMetrics | null {
    if (rrList.length < 2) {
      if (fallbackBpm && fallbackBpm > 0) {
        return {
          heartRate: fallbackBpm,
          lastRR: Math.round(60000 / fallbackBpm),
          rmssd: 0,
          sdnn: 0,
          pnn50: 0,
          state: "🟡 MODERATE HRV — collecting intervals",
        };
      }
      return null;
    }

    const n = rrList.length;
    const meanRR = rrList.reduce((acc, val) => acc + val, 0) / n;
    const heartRate = fallbackBpm && fallbackBpm > 0 ? fallbackBpm : +(60000 / meanRR).toFixed(1);
    const lastRR = rrList[n - 1];

    // Successive differences
    const diffs: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      diffs.push(rrList[i + 1] - rrList[i]);
    }

    // RMSSD
    const sumDiffSq = diffs.reduce((acc, d) => acc + d * d, 0);
    const rmssd = +(Math.sqrt(sumDiffSq / diffs.length)).toFixed(2);

    // SDNN
    const sumDevSq = rrList.reduce((acc, r) => acc + (r - meanRR) ** 2, 0);
    const sdnn = +(Math.sqrt(sumDevSq / Math.max(1, n - 1))).toFixed(2);

    // pNN50
    const count50 = diffs.filter((d) => Math.abs(d) > 50).length;
    const pnn50 = +((count50 / diffs.length) * 100).toFixed(1);

    // Classification
    let state = "🟡 MODERATE HRV — balanced autonomic tone";
    if (rmssd >= 45.0) {
      state = "🟢 HIGH HRV — relaxed / strong recovery";
    } else if (rmssd >= 25.0) {
      state = "🟡 MODERATE HRV — balanced autonomic tone";
    } else if (rmssd >= 15.0) {
      state = "🟠 LOW HRV — mild stress / elevated effort";
    } else {
      state = "🔴 VERY LOW HRV — high acute stress";
    }

    return {
      heartRate,
      lastRR,
      rmssd,
      sdnn,
      pnn50,
      state,
    };
  }

  /**
   * Compute Focus Index = Beta / (Alpha + Theta)
   */
  public computeFocusIndex(eegWindow: number[], sampleRate: number = 500): FocusMetrics | null {
    if (eegWindow.length < 256) return null;

    const floatInput = new Float32Array(512);
    const offset = Math.max(0, eegWindow.length - 512);
    for (let i = 0; i < 512 && offset + i < eegWindow.length; i++) {
      floatInput[i] = eegWindow[offset + i];
    }

    const mags = computeFFTMagnitudes(floatInput);
    const freqStep = sampleRate / 512;

    const calcBandPower = (startFreq: number, endFreq: number) => {
      const startBin = Math.max(1, Math.floor(startFreq / freqStep));
      const endBin = Math.min(Math.floor(endFreq / freqStep), mags.length - 1);
      let power = 0;
      let count = 0;
      for (let b = startBin; b <= endBin; b++) {
        power += mags[b] * mags[b];
        count++;
      }
      return count > 0 ? power / count : 0;
    };

    const beta = calcBandPower(13, 30);
    const alpha = calcBandPower(8, 13);
    const theta = calcBandPower(4, 8);

    const denom = alpha + theta;
    if (denom <= 0) return null;

    const focusIndex = +(beta / denom).toFixed(4);

    let state = "🔵 MIND WANDERING — disengaged";
    if (focusIndex >= 0.5) {
      state = "🔴 HIGH FOCUS — active cognitive load";
    } else if (focusIndex >= 0.3) {
      state = "🟡 MODERATE — engaged but easing";
    } else if (focusIndex >= 0.15) {
      state = "🟠 LOW — relaxed / transitioning";
    } else {
      state = "🔵 MIND WANDERING — disengaged";
    }

    return { focusIndex, state };
  }

  /**
   * Export HRV table to CSV format
   */
  public generateHrvCsv(): string {
    const header = [
      "session_id",
      "timestamp",
      "elapsed_s",
      "heart_rate_bpm",
      "rr_interval_ms",
      "rmssd",
      "sdnn",
      "pnn50",
      "state",
    ];

    const rows = this.hrvRecords.map((r) => [
      r.sessionId,
      r.timestamp,
      r.elapsedS,
      r.heartRate,
      r.rrIntervalMs,
      r.rmssd,
      r.sdnn,
      r.pnn50,
      JSON.stringify(r.state),
    ]);

    return [header.join(","), ...rows.map((row) => row.join(","))].join("\n");
  }

  /**
   * Export EEG table to CSV format
   * Counter,Channel1,Channel2,Channel3,...
   */
  public generateEegCsv(): string {
    const header = this.eegHeader.length > 0
      ? this.eegHeader
      : ["Counter", "Channel1", "Channel2", "Channel3"];

    const rows = this.eegRecords.map((r) => r.join(","));
    return [header.join(","), ...rows].join("\n");
  }

  /**
   * Legacy Focus CSV generator (now aliases to EEG CSV)
   */
  public generateFocusCsv(): string {
    if (this.eegRecords.length > 0) {
      return this.generateEegCsv();
    }
    const header = ["session_id", "timestamp", "elapsed_s", "focus_index", "state"];
    const rows = this.focusRecords.map((r) => [
      r.sessionId,
      r.timestamp,
      r.elapsedS,
      r.focusIndex,
      JSON.stringify(r.state),
    ]);
    return [header.join(","), ...rows].join("\n");
  }

  /**
   * Get raw row arrays for IndexedDB storage
   */
  public getHrvIndexedDbData(): (string | number)[][] {
    return this.hrvRecords.map((r) => [
      r.sessionId,
      r.timestamp,
      r.elapsedS,
      r.heartRate,
      r.rrIntervalMs,
      r.rmssd,
      r.sdnn,
      r.pnn50,
      r.state,
    ]);
  }

  public getEegIndexedDbData(): (string | number)[][] {
    return this.eegRecords;
  }

  public getFocusIndexedDbData(): (string | number)[][] {
    return this.eegRecords.length > 0 ? this.eegRecords : this.focusRecords.map((r) => [
      r.sessionId,
      r.timestamp,
      r.elapsedS,
      r.focusIndex,
      r.state,
    ]);
  }

  /**
   * Finish session and automatically trigger download of the CSV files
   */
  public finishSession(workerRef?: Worker | null): {
    hrvFilename: string | null;
    eegFilename: string | null;
    focusFilename: string | null;
    hrvCount: number;
    eegCount: number;
    focusCount: number;
    hrvBlob: Blob | null;
    eegBlob: Blob | null;
    focusBlob: Blob | null;
    hrvCsv: string | null;
    eegCsv: string | null;
    focusCsv: string | null;
  } {
    this.isActive = false;

    let hrvFilename: string | null = null;
    let eegFilename: string | null = null;
    let hrvBlob: Blob | null = null;
    let eegBlob: Blob | null = null;
    let hrvCsv: string | null = null;
    let eegCsv: string | null = null;

    // 1. Download HRV CSV (if HRV data was collected)
    if (this.hrvRecords.length > 0) {
      hrvFilename = `hrv_session_${this.sessionId}.csv`;
      hrvCsv = this.generateHrvCsv();
      hrvBlob = new Blob([hrvCsv], { type: "text/csv;charset=utf-8" });
      triggerBrowserDownload(hrvBlob, hrvFilename);

      // Also persist to IndexedDB so it appears in the Datasets drawer
      if (workerRef) {
        workerRef.postMessage({
          action: "write",
          data: this.getHrvIndexedDbData(),
          filename: hrvFilename,
          header: [
            "session_id",
            "timestamp",
            "elapsed_s",
            "heart_rate_bpm",
            "rr_interval_ms",
            "rmssd",
            "sdnn",
            "pnn50",
            "state",
          ],
        });
      }
    }

    // 2. Download EEG CSV (Counter, Channel1, Channel2, Channel3...)
    if (this.eegRecords.length > 0) {
      eegFilename = `eeg_session_${this.sessionId}.csv`;
      eegCsv = this.generateEegCsv();
      eegBlob = new Blob([eegCsv], { type: "text/csv;charset=utf-8" });
      triggerBrowserDownload(eegBlob, eegFilename);

      // Also persist to IndexedDB so it appears in the Datasets drawer
      if (workerRef) {
        workerRef.postMessage({
          action: "write",
          data: this.getEegIndexedDbData(),
          filename: eegFilename,
          header: this.eegHeader.length > 0 ? this.eegHeader : ["Counter", "Channel1", "Channel2", "Channel3"],
        });
      }
    }

    return {
      hrvFilename,
      eegFilename,
      focusFilename: eegFilename,
      hrvCount: this.hrvRecords.length,
      eegCount: this.eegRecords.length,
      focusCount: this.eegRecords.length,
      hrvBlob,
      eegBlob,
      focusBlob: eegBlob,
      hrvCsv,
      eegCsv,
      focusCsv: eegCsv,
    };
  }
}

// Global singleton
export const sessionMetricsManager = new SessionMetricsManager();
