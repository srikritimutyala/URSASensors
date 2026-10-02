import numpy as np
from collections import deque
from pylsl import StreamInlet, resolve_stream
import time
import csv
from datetime import datetime
from scipy.signal import butter, filtfilt, find_peaks


# ============================================================
# CONNECT TO LSL EEG / EXG STREAM
# ============================================================

print("Looking for LSL stream...")

# Connect to the biopotential stream (EEG + ECG/PPG)
streams = resolve_stream('type', 'EXG')
inlet = StreamInlet(streams[0])

# Determine sample rate dynamically from stream info (defaulting to 500 Hz)
stream_fs = inlet.info().nominal_srate()
FS = int(stream_fs) if stream_fs > 0 else 500

print(f"Connected to '{streams[0].name()}' ({FS} Hz, {inlet.info().channel_count()} channels)\n")


# ============================================================
# SETTINGS & CHANNEL MAPPING
# ============================================================

# Channel indices within the EXG stream:
EEG_CHANNEL = 0          # Channel index for EEG (Focus Index calculation)
ECG_CHANNEL = 1          # Channel index for ECG/PPG (Heart Rate & HRV calculation)
NUM_CHANNELS = max(3, inlet.info().channel_count())

# Buffer sizes:
BUFFER_SIZE = FS         # 1-second rolling buffer (500 samples) for EEG FFT
ECG_BUFFER_SIZE = FS * 5 # 5-second rolling buffer (2500 samples) for R-peak detection
RR_WINDOW_SIZE = 30      # Keep last 30 R-R intervals for moving HRV metrics

# Raw sample buffers for all channels
buffers = [
    deque(maxlen=max(BUFFER_SIZE, ECG_BUFFER_SIZE))
    for _ in range(NUM_CHANNELS)
]

# Heartbeat tracking state
rr_intervals = deque(maxlen=RR_WINDOW_SIZE)  # Store recent R-R intervals in ms
last_peak_sample_idx = -1
total_samples_received = 0

# Bandpass filter coefficients for ECG QRS extraction (5 Hz - 30 Hz)
nyq = 0.5 * FS
b_ecg, a_ecg = butter(2, [5.0 / nyq, 30.0 / nyq], btype='band')


# ============================================================
# THRESHOLDS & CLASSIFICATION
# ============================================================

# Focus Index Thresholds: Beta / (Alpha + Theta)
THRESHOLD_HIGH_FOCUS = 0.5
THRESHOLD_MODERATE_LOW = 0.3
THRESHOLD_MIND_WANDER = 0.15

# HRV Thresholds: RMSSD (Root Mean Square of Successive Differences in ms)
# Key physiological marker of parasympathetic (vagal) tone and stress
THRESHOLD_HIGH_HRV = 45.0      # Relaxed / strong parasympathetic tone
THRESHOLD_MODERATE_HRV = 25.0  # Balanced / moderate autonomic tone
THRESHOLD_LOW_HRV = 15.0       # Elevated cognitive load / acute stress


# ============================================================
# FOCUS INDEX CALCULATION
# ============================================================

def calculate_focs(data, fs=FS):
    data = np.array(data)

    if len(data) < 64:
        return None

    fft_vals = np.abs(np.fft.rfft(data))
    freqs = np.fft.rfftfreq(len(data), d=1 / fs)

    beta = np.mean(
        fft_vals[(freqs >= 13) & (freqs <= 30)] ** 2
    )

    alpha = np.mean(
        fft_vals[(freqs >= 8) & (freqs <= 13)] ** 2
    )

    theta = np.mean(
        fft_vals[(freqs >= 4) & (freqs <= 8)] ** 2
    )

    if (alpha + theta) == 0:
        return None

    return round(
        float(beta / (alpha + theta)),
        4
    )


# ============================================================
# HRV (HEART RATE VARIABILITY) CALCULATION
# ============================================================

def detect_r_peaks_and_update_rr(ecg_window, current_sample_idx, fs=FS):
    """
    Detects R-peaks in sliding ECG window, computes R-R intervals,
    and appends valid intervals to the rr_intervals deque.
    """
    global last_peak_sample_idx

    if len(ecg_window) < fs * 2:
        return

    ecg_arr = np.array(ecg_window, dtype=float)

    # 1. Bandpass filter ECG signal to isolate QRS complexes
    filtered_ecg = filtfilt(b_ecg, a_ecg, ecg_arr)

    # 2. Square signal to highlight dominant energy peaks
    squared = filtered_ecg ** 2

    # 3. Dynamic adaptive threshold and refractory period (min 350ms = max ~170 BPM)
    min_dist = int(0.35 * fs)
    threshold = np.mean(squared) + 1.0 * np.std(squared)

    peaks, _ = find_peaks(squared, distance=min_dist, height=threshold)

    # 4. Map detected peak indices into the cumulative sample timeline
    buffer_start_idx = current_sample_idx - len(ecg_window) + 1
    for p in peaks:
        abs_peak_idx = buffer_start_idx + p
        if abs_peak_idx > last_peak_sample_idx:
            if last_peak_sample_idx >= 0:
                rr_ms = ((abs_peak_idx - last_peak_sample_idx) / fs) * 1000.0
                # Physiological filter: 300 ms (200 BPM) to 2000 ms (30 BPM)
                if 300.0 <= rr_ms <= 2000.0:
                    rr_intervals.append(round(float(rr_ms), 1))
            last_peak_sample_idx = abs_peak_idx


def calculate_hrv(rr_list):
    """
    Computes time-domain HRV metrics:
    - heart_rate: Mean Heart Rate (BPM)
    - last_rr: Most recent R-R interval (ms)
    - rmssd: Root Mean Square of Successive Differences (parasympathetic tone)
    - sdnn: Standard Deviation of NN intervals (overall variability)
    - pnn50: Percentage of successive intervals differing by > 50 ms
    """
    if len(rr_list) < 3:
        return None

    rr = np.array(rr_list, dtype=float)
    mean_rr = np.mean(rr)
    heart_rate = round(float(60000.0 / mean_rr), 1)
    last_rr = round(float(rr[-1]), 1)
    sdnn = round(float(np.std(rr, ddof=1)), 2)

    rr_diff = np.diff(rr)
    if len(rr_diff) < 2:
        return None

    rmssd = round(float(np.sqrt(np.mean(rr_diff ** 2))), 2)
    pnn50 = round(float(np.mean(np.abs(rr_diff) > 50.0) * 100.0), 1)

    return {
        "heart_rate": heart_rate,
        "last_rr": last_rr,
        "rmssd": rmssd,
        "sdnn": sdnn,
        "pnn50": pnn50
    }


# ============================================================
# CREATE SEPARATE SESSION CSV FILES (FOCUS & HRV)
# ============================================================

session_id = datetime.now().strftime("%Y%m%d_%H%M%S")

# 1. Focus Session CSV Table
focus_filename = f"focus_session_{session_id}.csv"
focus_file = open(
    focus_filename,
    "w",
    newline="",
    encoding="utf-8"
)
focus_writer = csv.writer(focus_file)
focus_writer.writerow([
    "session_id",
    "timestamp",
    "lsl_timestamp",
    "focus_index",
    "state"
])
focus_file.flush()

# 2. HRV Session CSV Table (Separate table, shared session_id)
hrv_filename = f"hrv_session_{session_id}.csv"
hrv_file = open(
    hrv_filename,
    "w",
    newline="",
    encoding="utf-8"
)
hrv_writer = csv.writer(hrv_file)
hrv_writer.writerow([
    "session_id",
    "timestamp",
    "lsl_timestamp",
    "heart_rate_bpm",
    "last_rr_ms",
    "rmssd",
    "sdnn",
    "pnn50",
    "state"
])
hrv_file.flush()

print(f"Saving focus data to: {focus_filename}")
print(f"Saving HRV data to:   {hrv_filename}\n")


# ============================================================
# DISPLAY / STORAGE TIMING
# ============================================================

last_print = time.time()
PRINT_EVERY = 1.0  # seconds


# ============================================================
# MAIN LOOP
# ============================================================

try:
    while True:
        sample, lsl_timestamp = inlet.pull_sample()
        total_samples_received += 1

        for i in range(NUM_CHANNELS):
            buffers[i].append(sample[i])

        # Run R-peak detection twice per second (every FS // 2 samples)
        if (
            total_samples_received % (FS // 2) == 0
            and len(buffers[ECG_CHANNEL]) >= FS * 2
        ):
            detect_r_peaks_and_update_rr(
                list(buffers[ECG_CHANNEL]),
                total_samples_received,
                fs=FS
            )

        now = time.time()

        if (
            len(buffers[EEG_CHANNEL]) >= BUFFER_SIZE
            and (now - last_print) >= PRINT_EVERY
        ):
            last_print = now
            current_datetime = datetime.now().isoformat()

            # --------------------------------------------------------
            # 1. PROCESS & WRITE EEG FOCUS DATA
            # --------------------------------------------------------
            eeg_slice = list(buffers[EEG_CHANNEL])[-BUFFER_SIZE:]
            focs = calculate_focs(eeg_slice, fs=FS)

            if focs is not None:
                if focs >= THRESHOLD_HIGH_FOCUS:
                    focus_state = "🔴 HIGH FOCUS — active cognitive load"
                elif focs >= THRESHOLD_MODERATE_LOW:
                    focus_state = "🟡 MODERATE — engaged but easing"
                elif focs >= THRESHOLD_MIND_WANDER:
                    focus_state = "🟠 LOW — relaxed / transitioning"
                else:
                    focus_state = "🔵 MIND WANDERING — disengaged"

                focus_writer.writerow([
                    session_id,
                    current_datetime,
                    lsl_timestamp,
                    focs,
                    focus_state
                ])
                focus_file.flush()

                print(
                    f"{current_datetime} | "
                    f"FOCS: {focs:.4f} | "
                    f"{focus_state}"
                )

            # --------------------------------------------------------
            # 2. PROCESS & WRITE HRV DATA (SEPARATE TABLE)
            # --------------------------------------------------------
            hrv_metrics = calculate_hrv(rr_intervals)

            if hrv_metrics is not None:
                rmssd = hrv_metrics["rmssd"]

                if rmssd >= THRESHOLD_HIGH_HRV:
                    hrv_state = "🟢 HIGH HRV — relaxed / strong recovery"
                elif rmssd >= THRESHOLD_MODERATE_HRV:
                    hrv_state = "🟡 MODERATE HRV — balanced autonomic tone"
                elif rmssd >= THRESHOLD_LOW_HRV:
                    hrv_state = "🟠 LOW HRV — mild stress / elevated effort"
                else:
                    hrv_state = "🔴 VERY LOW HRV — high acute stress"

                hrv_writer.writerow([
                    session_id,
                    current_datetime,
                    lsl_timestamp,
                    hrv_metrics["heart_rate"],
                    hrv_metrics["last_rr"],
                    hrv_metrics["rmssd"],
                    hrv_metrics["sdnn"],
                    hrv_metrics["pnn50"],
                    hrv_state
                ])
                hrv_file.flush()

                print(
                    f"{current_datetime} | "
                    f"HR: {hrv_metrics['heart_rate']} BPM | "
                    f"RR: {hrv_metrics['last_rr']} ms | "
                    f"RMSSD: {hrv_metrics['rmssd']} ms | "
                    f"{hrv_state}"
                )
            else:
                beats_count = len(rr_intervals)
                print(
                    f"{current_datetime} | "
                    f"HRV: Detecting beats... ({beats_count}/3 beats gathered)"
                )


# ============================================================
# CLEANUP
# ============================================================

except KeyboardInterrupt:
    print("\nStopping EEG & HRV recording...")

finally:
    focus_file.close()
    hrv_file.close()

    print(f"\nFocus data saved to: {focus_filename}")
    print(f"HRV data saved to:   {hrv_filename}")
