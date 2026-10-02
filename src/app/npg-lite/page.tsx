'use client';
import React, {
    useEffect,
    useRef,
    useState,
    useCallback,
    useMemo,
} from "react";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { saveAs } from "file-saver";
import { WebglPlot, ColorRGBA, WebglLine } from "webgl-plot";
import Navbar from "@/components/Navbar";
import { Button } from "@/components/ui/button";
import { EXGFilter, Notch, HighPassFilter } from '@/components/filters';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { toast } from "sonner";
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import {
    Circle,
    CircleStop,
    CircleX,
    Infinity,
    Trash2,
    Download,
    FileArchive,
    Pause,
    Play,
    CircleOff,
    ReplaceAll,
    Heart,
    Brain,
    Eye,
    BicepsFlexed,
    Settings,
    Loader,
    Battery,
    BatteryLow,
    BatteryMedium,
    BatteryFull,
    BatteryWarning,
    Loader2
} from "lucide-react";
import { lightThemeColors, darkThemeColors, getCustomColor } from '@/components/Colors';
import { useTheme } from "next-themes";
import { polarBleManager } from "@/lib/polarBle";
import { sessionMetricsManager, triggerBrowserDownload } from "@/lib/sessionMetrics";

// Device configuration interface
interface DeviceConfig {
    maxChannels: number;
    sampleLength: number;
    hasBattery: boolean;
    name: string;
}

const defaultConfig: DeviceConfig = {
    maxChannels: 3,
    sampleLength: 7,
    hasBattery: false,
    name: ""
};

const NPG_Ble = () => {
    const isRecordingRef = useRef<boolean>(false); // Ref to track if the device is recording
    const isOldfirmwareRef = useRef<boolean>(false); // Ref to track if the device has old firmware
    const [isDisplay, setIsDisplay] = useState<boolean>(true); // Display state
    const [isRecord, setIsrecord] = useState<boolean>(true); // Display state
    const [isEndTimePopoverOpen, setIsEndTimePopoverOpen] = useState(false);
    const [datasets, setDatasets] = useState<any[]>([]);
    const [recordingElapsedTime, setRecordingElapsedTime] = useState<number>(0); // State to store the recording duration
    const [customTimeInput, setCustomTimeInput] = useState<string>(""); // State to store the custom stop time input
    const existingRecordRef = useRef<any | undefined>(undefined);
    const samplingrateref = useRef<number>(500);
    const recordingStartTimeRef = useRef<number>(0);
    const recordingStartPerfRef = useRef<number>(0); // High-precision start reference
    const totalSamplesRecordedRef = useRef<number>(0); // Running sample counter during recording
    const endTimeRef = useRef<number | null>(null); // Ref to store the end time of the recording
    const canvasElementCountRef = useRef<number>(1);
    const currentFileNameRef = useRef<string>("");
    const csvHeaderRef = useRef<string[]>([]);
    const [isFilterPopoverOpen, setIsFilterPopoverOpen] = useState(false);

    // Polar HRV state & refs
    const [isPolarConnected, setIsPolarConnected] = useState<boolean>(false);
    const [isPolarConnecting, setIsPolarConnecting] = useState<boolean>(false);
    const [polarDeviceName, setPolarDeviceName] = useState<string>("Polar Device");
    const [polarHeartRate, setPolarHeartRate] = useState<number | null>(null);
    const [polarLastRR, setPolarLastRR] = useState<number | null>(null);
    const [polarRmssd, setPolarRmssd] = useState<number | null>(null);
    const [polarHrvState, setPolarHrvState] = useState<string>("");
    const [polarBattery, setPolarBattery] = useState<number | null>(null);
    const [isPolarPopoverOpen, setIsPolarPopoverOpen] = useState<boolean>(false);

    const isPolarConnectedRef = useRef<boolean>(false);
    const latestHeartRateRef = useRef<number | null>(null);
    const polarLastRRRef = useRef<number | null>(null);
    const pendingRREventsRef = useRef<{ elapsedMs: number; rrMs: number }[]>([]);

    // Polar Rate Channel plotting refs and state
    const [showPolarChannel, setShowPolarChannel] = useState<boolean>(true);
    const showPolarChannelRef = useRef<boolean>(true);
    const polarPlotRef = useRef<WebglPlot | null>(null);
    const polarLineRef = useRef<WebglLine | null>(null);
    const polarSweepPos = useRef<number>(0);

    const NUM_BUFFERS = 4;
    const recordingBuffers = Array(NUM_BUFFERS)
        .fill(null)
        .map(() => [] as (number | string)[][]);
    const [wglPlots, setWglPlots] = useState<WebglPlot[]>([]);
    const canvasContainerRef = useRef<HTMLDivElement>(null);
    const dataPointCountRef = useRef<number>(2000); // To track the calculated value
    const [canvasElements, setCanvasElements] = useState<HTMLCanvasElement[]>([]);
    const linesRef = useRef<WebglLine[]>([]);
    const sweepPositions = useRef<number[]>(new Array(6).fill(0)); // Array for sweep positions
    const currentSweepPos = useRef<number[]>(new Array(6).fill(0)); // Array for sweep positions

    // Centralized device configuration
    const deviceConfigRef = useRef<DeviceConfig>(defaultConfig);
    const [deviceConfig, setDeviceConfig] = useState<DeviceConfig>(defaultConfig);

    // State for UI updates only
    const [batteryLevel, setBatteryLevel] = useState<number | null>(null); // Battery level percentage for UI
    const [deviceName, setDeviceName] = useState<string>(""); // Store device name for UI
    const [refreshKey, setRefreshKey] = useState(0); // Force re-render when config changes

    // Loading states for various operations
    const [isProcessingRecording, setIsProcessingRecording] = useState(false);
    const [isDownloadingAll, setIsDownloadingAll] = useState(false);
    const [isDownloadingFile, setIsDownloadingFile] = useState<{ [key: string]: boolean }>({});
    const [isDeletingFile, setIsDeletingFile] = useState<{ [key: string]: boolean }>({});
    const [isDeletingAll, setIsDeletingAll] = useState(false);

    // Derive channel names from device config
    const channelNames = useMemo(() =>
        Array.from({ length: deviceConfig.maxChannels }, (_, i) => `CH${i + 1}`),
        [deviceConfig.maxChannels]
    );

    const [selectedChannels, setSelectedChannels] = useState<number[]>([1]);
    const [manuallySelected, setManuallySelected] = useState(false); // New state to track manual selection
    const { theme } = useTheme(); // Current theme of the app
    const isDarkModeEnabled = theme === "dark"; // Boolean to check if dark mode is enabled
    const [isConnected, setIsConnected] = useState(false);
    const activeTheme: 'light' | 'dark' = isDarkModeEnabled ? 'dark' : 'light';
    const [isAllEnabledChannelSelected, setIsAllEnabledChannelSelected] = useState(false);
    const [isSelectAllDisabled, setIsSelectAllDisabled] = useState(false);
    const [isLoading, setIsLoading] = useState(false); // Track loading state for asynchronous operations
    const [open, setOpen] = useState(false);
    const selectedChannelsRef = useRef(selectedChannels);
    const [Zoom, SetZoom] = useState<number>(1); // Number of canvases
    const [timeBase, setTimeBase] = useState<number>(4); // To track the current index to show
    let activeBufferIndex = 0;
    const fillingindex = useRef<number>(0); // Initialize useRef with 0
    const MAX_BUFFER_SIZE = 500;
    const pauseRef = useRef<boolean>(true);

    const togglePause = () => {
        const newPauseState = !isDisplay;
        setIsDisplay(newPauseState);
        pauseRef.current = newPauseState;
    };
    const samplesReceivedRef = useRef(0);

    const createCanvasElements = () => {
        const container = canvasContainerRef.current;
        if (!container) {
            return; // Exit if the ref is null
        }

        currentSweepPos.current = new Array(deviceConfig.maxChannels).fill(0);
        sweepPositions.current = new Array(deviceConfig.maxChannels).fill(0);

        // Clear existing child elements and WebGL contexts
        while (container.firstChild) {
            const firstChild = container.firstChild as HTMLElement;
            if (firstChild instanceof HTMLCanvasElement) {
                const gl = firstChild.getContext("webgl");
                if (gl) {
                    const loseContext = gl.getExtension("WEBGL_lose_context");
                    if (loseContext) loseContext.loseContext();
                }
            } else if (firstChild && firstChild.querySelectorAll) {
                const canvases = firstChild.querySelectorAll("canvas");
                canvases.forEach((c) => {
                    const gl = c.getContext("webgl");
                    if (gl) {
                        const loseContext = gl.getExtension("WEBGL_lose_context");
                        if (loseContext) loseContext.loseContext();
                    }
                });
            }
            container.removeChild(firstChild);
        }

        setCanvasElements([]);
        setWglPlots([]);
        linesRef.current = [];
        const newcanvasElements: HTMLCanvasElement[] = [];
        const newWglPlots: WebglPlot[] = [];
        const newLines: WebglLine[] = [];

        // Total channels to render (EXG channels + optional Polar Rate channel)
        const hasPolar = showPolarChannel;
        const totalChannelCount = selectedChannels.length + (hasPolar ? 1 : 0);
        const channelHeight = container.clientHeight / Math.max(1, totalChannelCount);

        // Create grid lines
        const canvasWrapper = document.createElement("div");
        canvasWrapper.className = "absolute inset-0 pointer-events-none";
        const opacityDarkMajor = "0.2";
        const opacityDarkMinor = "0.05";
        const opacityLightMajor = "0.4";
        const opacityLightMinor = "0.1";
        const distanceminor = samplingrateref.current * 0.04;
        const numGridLines = (500 * 4) / distanceminor;

        for (let j = 1; j < numGridLines; j++) {
            const gridLineX = document.createElement("div");
            gridLineX.className = "absolute bg-[rgb(128,128,128)]";
            gridLineX.style.width = "1px";
            gridLineX.style.height = "100%";
            gridLineX.style.left = `${((j / numGridLines) * 100).toFixed(3)}%`;
            gridLineX.style.opacity = j % 5 === 0 ? (theme === "dark" ? opacityDarkMajor : opacityLightMajor) : (theme === "dark" ? opacityDarkMinor : opacityLightMinor);
            canvasWrapper.appendChild(gridLineX);
        }

        const horizontalline = 50;
        for (let j = 1; j < horizontalline; j++) {
            const gridLineY = document.createElement("div");
            gridLineY.className = "absolute bg-[rgb(128,128,128)]";
            gridLineY.style.height = "1px";
            gridLineY.style.width = "100%";
            gridLineY.style.top = `${((j / horizontalline) * 100).toFixed(3)}%`;
            gridLineY.style.opacity = j % 5 === 0 ? (theme === "dark" ? opacityDarkMajor : opacityLightMajor) : (theme === "dark" ? opacityDarkMinor : opacityLightMinor);
            canvasWrapper.appendChild(gridLineY);
        }
        container.appendChild(canvasWrapper);

        // Create canvasElements for each selected channel
        selectedChannels.forEach((channelNumber) => {
            const canvasWrapper = document.createElement("div");
            canvasWrapper.className = "canvas-container relative flex-[1_1_0%]";

            const canvas = document.createElement("canvas");
            canvas.id = `canvas${channelNumber}`;
            canvas.width = container.clientWidth;
            canvas.height = channelHeight;
            canvas.className = "w-full h-full block rounded-xl";

            const badge = document.createElement("div");
            badge.className = "absolute text-gray-500 text-sm rounded-full p-2 m-2 select-none z-10";
            badge.innerText = `CH${channelNumber}`;

            canvasWrapper.appendChild(badge);
            canvasWrapper.appendChild(canvas);
            container.appendChild(canvasWrapper);

            newcanvasElements.push(canvas);
            const wglp = new WebglPlot(canvas);
            newWglPlots.push(wglp);
            wglp.gScaleY = Zoom;

            const line = new WebglLine(getLineColor(channelNumber, theme), dataPointCountRef.current);
            wglp.gOffsetY = 0;
            line.offsetY = 0;
            line.lineSpaceX(-1, 2 / dataPointCountRef.current);

            wglp.addLine(line);
            newLines.push(line);
        });

        // Create Polar Rate channel canvas if enabled
        if (hasPolar) {
            const polarWrapper = document.createElement("div");
            polarWrapper.className = "canvas-container relative flex-[1_1_0%]";

            const polarCanvas = document.createElement("canvas");
            polarCanvas.id = "canvasPolar";
            polarCanvas.width = container.clientWidth;
            polarCanvas.height = channelHeight;
            polarCanvas.className = "w-full h-full block rounded-xl";

            const badge = document.createElement("div");
            badge.id = "polar-channel-badge";
            badge.className = "absolute text-rose-500 font-semibold text-xs md:text-sm rounded-full px-3 py-1 m-2 flex items-center gap-1.5 bg-rose-500/10 border border-rose-500/30 backdrop-blur-sm z-10 select-none";
            const hrVal = latestHeartRateRef.current
                ? `${Math.round(latestHeartRateRef.current)} BPM`
                : (isPolarConnectedRef.current ? "Measuring..." : "Polar HR (Disconnected)");
            badge.innerHTML = `<span class="flex items-center gap-1"><span>❤️</span> POLAR HR:</span><span class="font-bold text-foreground" id="polar-badge-val">${hrVal}</span>`;

            polarWrapper.appendChild(badge);
            polarWrapper.appendChild(polarCanvas);
            container.appendChild(polarWrapper);

            newcanvasElements.push(polarCanvas);
            const polarWglp = new WebglPlot(polarCanvas);
            polarPlotRef.current = polarWglp;
            newWglPlots.push(polarWglp);
            polarWglp.gScaleY = Zoom;

            const polarColor = new ColorRGBA(0.957, 0.247, 0.369, theme === "dark" ? 1.0 : 0.85);
            const polarLine = new WebglLine(polarColor, dataPointCountRef.current);
            polarWglp.gOffsetY = 0;
            polarLine.offsetY = 0;
            polarLine.lineSpaceX(-1, 2 / dataPointCountRef.current);

            for (let k = 0; k < polarLine.numPoints; k++) {
                polarLine.setY(k, -0.6);
            }

            polarWglp.addLine(polarLine);
            polarLineRef.current = polarLine;
            polarSweepPos.current = 0;
        } else {
            polarPlotRef.current = null;
            polarLineRef.current = null;
        }

        linesRef.current = newLines;
        setCanvasElements(newcanvasElements);
        setWglPlots(newWglPlots);
    };

    const getLineColor = (channelNumber: number, theme: string | undefined): ColorRGBA => {
        // Convert 1-indexed channel number to a 0-indexed index
        const index = channelNumber - 1;
        const colors = theme === "dark" ? darkThemeColors : lightThemeColors;
        const hex = colors[index % colors.length];

        const r = parseInt(hex.slice(1, 3), 16) / 255;
        const g = parseInt(hex.slice(3, 5), 16) / 255;
        const b = parseInt(hex.slice(5, 7), 16) / 255;
        const alpha = theme === "dark" ? 1 : 0.8;  // Slight transparency for light theme

        return new ColorRGBA(r, g, b, alpha);
    };

    const handleSelectAllToggle = () => {
        const enabledChannels = Array.from({ length: deviceConfig.maxChannels }, (_, i) => i + 1);

        if (!isAllEnabledChannelSelected) {
            // Programmatic selection of all channels
            setManuallySelected(false); // Mark as not manual
            setSelectedChannels(enabledChannels); // Select all channels
        } else {
            // RESET functionality
            const savedchannels = JSON.parse(localStorage.getItem('savedchannels') || '[]');
            let initialSelectedChannelsRefs: number[] = [1]; // Default to channel 1

            // Get the saved channels for the device
            initialSelectedChannelsRefs = [1]; // Load saved channels or default to [1]

            // Set the channels back to saved values
            setSelectedChannels(initialSelectedChannelsRefs); // Reset to saved channels
        }

        // Toggle the "Select All" button state
        setIsAllEnabledChannelSelected((prevState) => !prevState);
    };

    const [refresh, setRefresh] = useState(0);

    useEffect(() => {
        showPolarChannelRef.current = showPolarChannel;
    }, [showPolarChannel]);

    // Helper to plot a Polar Rate point on the WebglLine
    const plotPolarPoint = useCallback((bpmValue: number | null) => {
        const line = polarLineRef.current;
        if (!line) return;

        // Normalization: 40 BPM -> -0.75, 100 BPM -> 0.0, 160 BPM -> +0.75
        let normY = -0.6;
        if (bpmValue && bpmValue > 0) {
            normY = Math.max(-0.95, Math.min(0.95, (bpmValue - 100) / 80));
        }

        const curPos = polarSweepPos.current % line.numPoints;
        try {
            line.setY(curPos, normY);
        } catch (e) {}

        const clearPos = Math.ceil((curPos + dataPointCountRef.current / 100) % line.numPoints);
        try {
            line.setY(clearPos, NaN);
        } catch (e) {}

        polarSweepPos.current = (curPos + 1) % line.numPoints;
    }, []);

    useEffect(() => {
        createCanvasElements();
        setRefresh(r => r + 1);
    }, [deviceConfig.maxChannels, theme, timeBase, selectedChannels, Zoom, isConnected, refreshKey, showPolarChannel]);

    useEffect(() => {
        selectedChannelsRef.current = selectedChannels;
        canvasElementCountRef.current = selectedChannels.length;
    }, [selectedChannels]);

    // Independent sweep animation when only Polar is connected without NPG
    useEffect(() => {
        if (isConnected) return;
        if (!showPolarChannel) return;

        const interval = setInterval(() => {
            if (!pauseRef.current) return;
            const bpm = latestHeartRateRef.current;
            const pointsPerTick = 10;
            for (let p = 0; p < pointsPerTick; p++) {
                plotPolarPoint(isPolarConnectedRef.current ? bpm : null);
            }
            if (polarPlotRef.current) {
                try {
                    polarPlotRef.current.update();
                } catch (e) {}
            }
        }, 20);

        return () => clearInterval(interval);
    }, [isConnected, showPolarChannel, isPolarConnected, plotPolarPoint]);

    // Polar BLE subscription and event handling
    useEffect(() => {
        const unsubStatus = polarBleManager.onStatus((connected, name) => {
            setIsPolarConnected(connected);
            isPolarConnectedRef.current = connected;
            setPolarDeviceName(name);
            if (!connected) {
                setPolarHeartRate(null);
                setPolarLastRR(null);
                latestHeartRateRef.current = null;
            } else {
                setShowPolarChannel(true);
            }

            const badgeValEl = document.getElementById("polar-badge-val");
            if (badgeValEl) {
                badgeValEl.textContent = connected ? "Connected (measuring...)" : "Polar Disconnected";
            }
        });

        const unsubBattery = polarBleManager.onBattery((level) => {
            setPolarBattery(level);
        });

        const unsubMeasurement = polarBleManager.onMeasurement((m) => {
            setPolarHeartRate(m.heartRate);
            latestHeartRateRef.current = m.heartRate;

            let lastRR: number | null = null;
            if (m.rrIntervals && m.rrIntervals.length > 0) {
                lastRR = m.rrIntervals[m.rrIntervals.length - 1];
                setPolarLastRR(lastRR);
                polarLastRRRef.current = lastRR;
            }

            const badgeValEl = document.getElementById("polar-badge-val");
            if (badgeValEl) {
                const rrText = lastRR ? ` (${lastRR}ms)` : "";
                badgeValEl.textContent = `${m.heartRate} BPM${rrText}`;
            }

            // If synchronized recording is active, queue RR intervals and record HRV session data
            if (isRecordingRef.current && recordingStartTimeRef.current > 0) {
                const elapsedSeconds = (Date.now() - recordingStartTimeRef.current) / 1000;
                const hrvMetrics = sessionMetricsManager.processPolarMeasurement(m, elapsedSeconds);
                if (hrvMetrics) {
                    setPolarRmssd(hrvMetrics.rmssd);
                    setPolarHrvState(hrvMetrics.state);
                }

                if (recordingStartPerfRef.current > 0) {
                    const elapsedMs = m.performanceTimestamp - recordingStartPerfRef.current;
                    for (const rr of m.rrIntervals) {
                        pendingRREventsRef.current.push({ elapsedMs, rrMs: rr });
                    }
                }
            }
        });

        return () => {
            unsubStatus();
            unsubBattery();
            unsubMeasurement();
        };
    }, []);

    const handleConnectPolar = async (acceptAll: boolean = false) => {
        try {
            setIsPolarConnecting(true);
            await polarBleManager.connect(acceptAll);
            toast.success(`Connected to ${polarBleManager.deviceName}`);
        } catch (err: any) {
            if (err.name === "NotFoundError" || err.message?.includes("User cancelled")) {
                toast.info("Sensor not detected or cancelled", {
                    description: (
                        <div className="text-xs space-y-1 mt-1">
                            <p className="font-semibold text-foreground">Can&apos;t find your HRV sensor?</p>
                            <p>• Wet strap electrodes &amp; wear it (sensor sleeps when dry).</p>
                            <p>• Disconnect from phone/Polar Beat (supports 1 BLE connection).</p>
                            <p>• Forget in Mac Bluetooth settings if paired.</p>
                        </div>
                    ),
                    action: {
                        label: "Scan All Devices",
                        onClick: () => handleConnectPolar(true),
                    },
                    duration: 9000,
                });
            } else if (err.name === "PolarConnectionError" || err.message?.includes("Unsupported device")) {
                toast.error("Polar connection failed (Unsupported Device)", {
                    description: (
                        <div className="text-xs space-y-1 mt-1">
                            <p className="font-semibold">Quick troubleshooting checklist:</p>
                            <p>• Wet strap electrodes &amp; wear it (sensor sleeps when dry).</p>
                            <p>• Disconnect from phone/Polar Beat (supports 1 BLE connection).</p>
                            <p>• In Mac Bluetooth settings, click &apos;Forget This Device&apos; if paired.</p>
                        </div>
                    ),
                    action: {
                        label: "Try All Devices",
                        onClick: () => handleConnectPolar(true),
                    },
                    duration: 10000,
                });
            } else {
                toast.error(err.message || "Failed to connect to Polar sensor");
            }
        } finally {
            setIsPolarConnecting(false);
        }
    };

    const handleDisconnectPolar = async () => {
        try {
            await polarBleManager.disconnect();
            toast.info("Polar sensor disconnected");
        } catch (err) {
            toast.error("Error disconnecting Polar");
        }
    };

    //filters
    const appliedFiltersRef = React.useRef<{ [key: number]: number }>({});
    const appliedEXGFiltersRef = React.useRef<{ [key: number]: number }>({});
    const [, forceUpdate] = React.useReducer((x) => x + 1, 0);
    const [, forceEXGUpdate] = React.useReducer((x) => x + 1, 0);

    const removeEXGFilter = (channelIndex: number) => {
        delete appliedEXGFiltersRef.current[channelIndex]; // Remove the filter for the channel
        forceEXGUpdate(); // Trigger re-render

    };

    // Function to handle frequency selection
    const handleFrequencySelectionEXG = (channelIndex: number, frequency: number) => {
        appliedEXGFiltersRef.current[channelIndex] = frequency; // Update the filter for the channel
        forceEXGUpdate(); //Trigger re-render

    };

    // Function to set the same filter for all channels
    const applyEXGFilterToAllChannels = (channels: number[], frequency: number) => {
        channels.forEach((channelIndex) => {
            appliedEXGFiltersRef.current[channelIndex] = frequency; // Set the filter for the channel
        });
        forceEXGUpdate(); // Trigger re-render

    };
    // Function to remove the filter for all channels
    const removeEXGFilterFromAllChannels = (channels: number[]) => {
        channels.forEach((channelIndex) => {
            delete appliedEXGFiltersRef.current[channelIndex]; // Remove the filter for the channel
        });
        forceEXGUpdate(); // Trigger re-render

    };
    const removeNotchFilter = (channelIndex: number) => {
        delete appliedFiltersRef.current[channelIndex]; // Remove the filter for the channel
        forceUpdate(); // Trigger re-render
    };
    // Function to handle frequency selection
    const handleFrequencySelection = (channelIndex: number, frequency: number) => {
        appliedFiltersRef.current[channelIndex] = frequency; // Update the filter for the channel
        forceUpdate(); //Trigger re-render
    };

    // Function to set the same filter for all channels
    const applyFilterToAllChannels = (channels: number[], frequency: number) => {
        channels.forEach((channelIndex) => {
            appliedFiltersRef.current[channelIndex] = frequency; // Set the filter for the channel
        });
        forceUpdate(); // Trigger re-render
    };

    // Function to remove the filter for all channels
    const removeNotchFromAllChannels = (channels: number[]) => {
        channels.forEach((channelIndex) => {
            delete appliedFiltersRef.current[channelIndex]; // Remove the filter for the channel
        });
        forceUpdate(); // Trigger re-render
    };

    useEffect(() => {
        dataPointCountRef.current = (samplingrateref.current * timeBase);
    }, [timeBase]);

    const zoomRef = useRef(Zoom);

    useEffect(() => {
        zoomRef.current = Zoom;
    }, [Zoom]);

    const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
    const DATA_CHAR_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
    const CONTROL_CHAR_UUID = "0000ff01-0000-1000-8000-00805f9b34fb";
    const BATTERY_CHAR_UUID = "f633d0ec-46b4-43c1-a39f-1ca06d0602e1";  // Battery characteristic UUID

    let prevSampleCounter: number | null = null;
    let channelData: number[] = [];

    // Initialize filters with device config
    const notchFiltersRef = useRef(Array.from({ length: deviceConfig.maxChannels }, () => new Notch()));
    const exgFiltersRef = useRef(Array.from({ length: deviceConfig.maxChannels }, () => new EXGFilter()));
    const pointoneFilterRef = useRef(Array.from({ length: deviceConfig.maxChannels }, () => new HighPassFilter()));

    // Update filters when device config changes
    useEffect(() => {
        const config = deviceConfigRef.current;

        notchFiltersRef.current = Array.from({ length: config.maxChannels }, () => new Notch());
        exgFiltersRef.current = Array.from({ length: config.maxChannels }, () => new EXGFilter());
        pointoneFilterRef.current = Array.from({ length: config.maxChannels }, () => new HighPassFilter());

        notchFiltersRef.current.forEach((filter) => {
            filter.setbits(samplingrateref.current);
        });
        exgFiltersRef.current.forEach((filter) => {
            filter.setbits("12", samplingrateref.current);
        });
        pointoneFilterRef.current.forEach((filter) => {
            filter.setSamplingRate(samplingrateref.current);
        });
    }, [deviceConfig]);

    // Function to update device configuration based on name
    const updateDeviceConfiguration = (name: string) => {
        let newConfig: DeviceConfig;

        if (name.includes("3CH")) {
            newConfig = {
                maxChannels: 3,
                sampleLength: 7, // 3 channels * 2 bytes + 1 byte counter = 7 bytes
                hasBattery: true,
                name
            };
            isOldfirmwareRef.current = false; // Mark as new firmware if 3CH device is detected
        } else if (name.includes("6CH")) {
            newConfig = {
                maxChannels: 6,
                sampleLength: 13, // 6 channels * 2 bytes + 1 byte counter = 13 bytes
                hasBattery: true,
                name
            };
            isOldfirmwareRef.current = false; // Mark as new firmware if 6CH device is detected 
        } else {
            newConfig = {
                maxChannels: 3,
                sampleLength: 7,
                hasBattery: false,
                name
            };
            isOldfirmwareRef.current = true; // Mark as old firmware if device name doesn't match known patterns
        }

        // Update both ref and state
        deviceConfigRef.current = newConfig;
        setDeviceConfig(newConfig);
        setDeviceName(name);

        // Reinitialize filters with new channel count
        notchFiltersRef.current = Array.from({ length: newConfig.maxChannels }, () => new Notch());
        exgFiltersRef.current = Array.from({ length: newConfig.maxChannels }, () => new EXGFilter());
        pointoneFilterRef.current = Array.from({ length: newConfig.maxChannels }, () => new HighPassFilter());

        // Initialize filters
        notchFiltersRef.current.forEach((filter) => {
            filter.setbits(samplingrateref.current);
        });
        exgFiltersRef.current.forEach((filter) => {
            filter.setbits("12", samplingrateref.current);
        });
        pointoneFilterRef.current.forEach((filter) => {
            filter.setSamplingRate(samplingrateref.current);
        });

        // Reset UI states
        setSelectedChannels([1]);
        setManuallySelected(false);
        setBatteryLevel(null);

        // Force re-render to update UI with new channel count
        setRefreshKey(prev => prev + 1);
    };

    const BLOCK_COUNT = 10; // 10 samples batched per notification
    // Dynamic packet length based on current device config
    const packetLengthRef = useRef<number>(0);
    useEffect(() => {
        packetLengthRef.current = deviceConfigRef.current.sampleLength * BLOCK_COUNT;
    }, [deviceConfig]);

    // Inside your component
    const processSample = useCallback((dataView: DataView): void => {
        const config = deviceConfigRef.current;

        if (dataView.byteLength !== config.sampleLength) {
            console.log("Unexpected sample length: " + dataView.byteLength);
            return;
        }

        const sampleCounter = dataView.getUint8(0);

        if (prevSampleCounter === null) {
            prevSampleCounter = sampleCounter;
        } else {
            const expected = (prevSampleCounter + 1) % 256;
            if (sampleCounter !== expected) {
                console.log(`Missing sample: expected ${expected}, got ${sampleCounter}`);
            }
            prevSampleCounter = sampleCounter;
        }

        channelData.push(sampleCounter);

        // Process the correct number of channels based on device configuration
        for (let channel = 0; channel < config.maxChannels; channel++) {
            const sample = dataView.getInt16(1 + (channel * 2), false);
            channelData.push(
                notchFiltersRef.current[channel].process(
                    exgFiltersRef.current[channel].process(
                        pointoneFilterRef.current[channel].process(sample),
                        appliedEXGFiltersRef.current[channel]
                    ),
                    appliedFiltersRef.current[channel]
                )
            );
        }

        updatePlots(channelData, zoomRef.current);

        if (isRecordingRef.current) {
            const sampleIdx = totalSamplesRecordedRef.current;
            totalSamplesRecordedRef.current += 1;
            const sampleRate = samplingrateref.current || 500;
            const elapsedSeconds = +(sampleIdx / sampleRate).toFixed(4);
            const sampleTimestampMs = recordingStartTimeRef.current + Math.round((sampleIdx / sampleRate) * 1000);
            const counter = channelData[0];
            const channelValues = selectedChannels.map((ch) => channelData[ch] !== undefined ? channelData[ch] : 0);

            let rowData: (number | string)[];

            if (isPolarConnectedRef.current) {
                // Check if an RR interval event occurred for this sample window
                const sampleElapsedMs = (sampleIdx / sampleRate) * 1000;
                let matchedRR: number | string = "";

                if (pendingRREventsRef.current.length > 0) {
                    const nextEvent = pendingRREventsRef.current[0];
                    if (nextEvent.elapsedMs <= sampleElapsedMs + (1000 / sampleRate)) {
                        matchedRR = nextEvent.rrMs;
                        pendingRREventsRef.current.shift();
                    }
                }

                const currentBpm = latestHeartRateRef.current !== null ? latestHeartRateRef.current : "";
                rowData = [sampleTimestampMs, elapsedSeconds, counter, ...channelValues, currentBpm, matchedRR];
            } else {
                rowData = [sampleTimestampMs, elapsedSeconds, counter, ...channelValues];
            }

            // Feed EEG for Focus Index (using first selected channel)
            if (channelValues.length > 0) {
                sessionMetricsManager.processEegSample(channelValues[0], elapsedSeconds, sampleRate);
            }

            // Feed ECG fallback if Polar is not connected and a secondary channel exists
            if (!isPolarConnectedRef.current && channelValues.length > 1) {
                const hrvMetrics = sessionMetricsManager.processEcgSample(channelValues[1], elapsedSeconds, sampleRate);
                if (hrvMetrics) {
                    setPolarHeartRate(hrvMetrics.heartRate);
                    setPolarLastRR(hrvMetrics.lastRR);
                    setPolarRmssd(hrvMetrics.rmssd);
                    setPolarHrvState(hrvMetrics.state);
                }
            }

            recordingBuffers[activeBufferIndex][fillingindex.current] = rowData;

            if (fillingindex.current >= MAX_BUFFER_SIZE - 1) {
                processBuffer(activeBufferIndex, canvasElementCountRef.current, selectedChannels);
                activeBufferIndex = (activeBufferIndex + 1) % NUM_BUFFERS;
            }

            fillingindex.current = (fillingindex.current + 1) % MAX_BUFFER_SIZE;

            const elapsedTime = Date.now() - recordingStartTimeRef.current;
            setRecordingElapsedTime((prev) => {
                if (endTimeRef.current !== null && elapsedTime >= endTimeRef.current) {
                    stopRecording();
                    return endTimeRef.current;
                }
                return elapsedTime;
            });
        }

        channelData = [];
        samplesReceivedRef.current += 1;
    }, [
        canvasElementCountRef.current, selectedChannels, timeBase, deviceConfig
    ]);

    interface BluetoothRemoteGATTCharacteristicExtended extends EventTarget {
        value?: DataView;
    }

    function handleNotification(event: Event): void {
        const target = event.target as BluetoothRemoteGATTCharacteristicExtended;
        if (!target.value) {
            console.log("Received event with no value.");
            return;
        }

        const config = deviceConfigRef.current;
        const currentPacketLength = packetLengthRef.current;

        const value = target.value;
        if (value.byteLength === currentPacketLength) {
            for (let i = 0; i < currentPacketLength; i += config.sampleLength) {
                const sampleBuffer = value.buffer.slice(i, i + config.sampleLength);
                const sampleDataView = new DataView(sampleBuffer);
                processSample(sampleDataView);
            }
        } else if (value.byteLength === config.sampleLength) {
            processSample(new DataView(value.buffer));
        } else {
            console.log("Unexpected packet length: " + value.byteLength);
        }
    }

    const connectedDeviceRef = useRef<any | null>(null); // UseRef for device tracking
    const batteryCharacteristicRef = useRef<any | null>(null); // Ref for battery characteristic

    const disconnectIntervalRef = useRef<NodeJS.Timeout | null>(null);

    // Update the connectBLE function
    async function connectBLE(): Promise<void> {
        try {
            setIsLoading(true);
            const nav = navigator as any;
            if (!nav.bluetooth) {
                console.log("Web Bluetooth API is not available in this browser.");
                setIsLoading(false);
                return;
            }

            const device = await nav.bluetooth.requestDevice({
                filters: [{ namePrefix: "NPG" }],
                optionalServices: [SERVICE_UUID],
            });

            // Update configuration based on device name
            updateDeviceConfiguration(device.name || "");

            const server = await device.gatt?.connect();
            if (!server) {
                setIsLoading(false);
                return;
            }

            connectedDeviceRef.current = device;
            const service = await server.getPrimaryService(SERVICE_UUID);
            const controlChar = await service.getCharacteristic(CONTROL_CHAR_UUID);
            const dataChar = await service.getCharacteristic(DATA_CHAR_UUID);

            // Try to get battery characteristic if device supports it
            if (deviceConfigRef.current.hasBattery) {
                try {
                    const batteryChar = await service.getCharacteristic(BATTERY_CHAR_UUID);
                    batteryCharacteristicRef.current = batteryChar;
                    await batteryChar.startNotifications();

                    batteryChar.addEventListener("characteristicvaluechanged", (event: any) => {
                        const target = event.target as BluetoothRemoteGATTCharacteristicExtended;
                        if (target.value && target.value.byteLength === 1) {
                            const batteryValue = target.value.getUint8(0);
                            setBatteryLevel(batteryValue);
                        }
                    });
                } catch (error) {
                    console.log("Battery characteristic not available:", error);
                }
            }

            const encoder = new TextEncoder();
            await controlChar.writeValue(encoder.encode("START"));
            await dataChar.startNotifications();
            dataChar.addEventListener("characteristicvaluechanged", handleNotification);
            setIsConnected(true);
            setIsLoading(false);
            getFileCountFromIndexedDB();
            // Clear any existing interval first
            if (disconnectIntervalRef.current) {
                clearInterval(disconnectIntervalRef.current);
                disconnectIntervalRef.current = null;
            }

            // Create new interval for monitoring samples
            disconnectIntervalRef.current = setInterval(() => {
                if (samplesReceivedRef.current === 0) {
                    console.log("No samples received in 1 second, disconnecting...");
                    // Clear the interval before calling disconnect
                    if (disconnectIntervalRef.current) {
                        clearInterval(disconnectIntervalRef.current);
                        disconnectIntervalRef.current = null;
                    }
                    disconnect();
                }
                samplesReceivedRef.current = 0;
            }, 1000);
        } catch (error) {
            console.log("Error: " + (error instanceof Error ? error.message : error));
            setIsLoading(false);
        }
    }

    async function disconnect(): Promise<void> {
        try {
            setIsLoading(true); // Show loading while disconnecting
            if (disconnectIntervalRef.current) {
                clearInterval(disconnectIntervalRef.current);
                disconnectIntervalRef.current = null;
            }

            // Clear any existing timeouts/intervals
            if (samplesReceivedRef.current > 0) {
                // Clear the interval that checks for samples
                const checkInterval = setInterval(() => { });
                clearInterval(checkInterval);
            }

            if (!connectedDeviceRef.current) {
                console.log("No connected device to disconnect.");
                setIsLoading(false);
                return;
            }

            const server = connectedDeviceRef.current.gatt;
            if (!server) {
                setIsLoading(false);
                return;
            }

            try {
                // Only try to stop notifications if server is connected
                if (server.connected) {
                    const service = await server.getPrimaryService(SERVICE_UUID);

                    // Stop data notifications
                    try {
                        const dataChar = await service.getCharacteristic(DATA_CHAR_UUID);
                        await dataChar.stopNotifications();
                        dataChar.removeEventListener("characteristicvaluechanged", handleNotification);
                    } catch (error) {
                        console.log("Error stopping data notifications:", error);
                    }

                    // Send stop command if control characteristic exists
                    try {
                        const controlChar = await service.getCharacteristic(CONTROL_CHAR_UUID);
                        const encoder = new TextEncoder();
                        await controlChar.writeValue(encoder.encode("STOP"));
                    } catch (error) {
                        console.log("Error sending STOP command:", error);
                    }

                    // Disconnect from device
                    server.disconnect();
                }
            } catch (error) {
                console.log("Error during cleanup:", error);
            } finally {
                // Reset all states and refs
                connectedDeviceRef.current = null;
                setIsConnected(false);
                setBatteryLevel(null);
                setDeviceName("");
                getFileCountFromIndexedDB();

                // Reset device configuration to defaults
                deviceConfigRef.current = defaultConfig;
                setDeviceConfig(defaultConfig);

                // Reset sample tracking
                prevSampleCounter = null;
                channelData = [];
                samplesReceivedRef.current = 0;

                // Reset recording state
                isRecordingRef.current = false;
                setIsrecord(true);
                setRecordingElapsedTime(0);

                // Reset UI states
                setIsDisplay(true);
                pauseRef.current = true;

                // Clear buffers
                recordingBuffers.forEach(buffer => buffer.length = 0);
                activeBufferIndex = 0;
                fillingindex.current = 0;

                // Clear lines and sweep positions
                linesRef.current = [];
                sweepPositions.current = new Array(6).fill(0);
                currentSweepPos.current = new Array(6).fill(0);

                // Force re-render
                setRefreshKey(prev => prev + 1);

                setIsLoading(false);
            }
        } catch (error) {
            console.log("Error during disconnection: " + (error instanceof Error ? error.message : error));
            setIsLoading(false);
        }
    }

    const workerRef = useRef<Worker | null>(null);

    const initializeWorker = () => {
        if (!workerRef.current && typeof window !== "undefined") {
            workerRef.current = new Worker(new URL('../../../workers/indexedDBWorker.ts', import.meta.url), {
                type: 'module',
            });

            // Set up worker message handler
            workerRef.current.onmessage = (event) => {
                const { action, filename, success, blob, error, allData } = event.data;

                switch (action) {
                    case 'writeComplete':
                        console.log(`Write completed for ${filename}: ${success}`);
                        break;

                    case 'getFileCountFromIndexedDB':
                        if (allData) {
                            setDatasets(allData);
                        }
                        break;

                    case 'saveDataByFilename':
                        if (blob) {
                            saveAs(blob, filename);
                            toast.success(`File "${filename}" downloaded successfully.`);
                            setIsDownloadingFile(prev => ({ ...prev, [filename]: false }));
                        } else if (error) {
                            console.warn("Download error:", error);
                            toast.error(`Error downloading file: ${error}`);
                            setIsDownloadingFile(prev => ({ ...prev, [filename]: false }));
                        }
                        break;

                    case 'saveAsZip':
                        if (blob) {
                            saveAs(blob, 'ChordsWeb.zip');
                            toast.success("All files downloaded successfully as ZIP.");
                            setIsDownloadingAll(false);
                        } else if (error) {
                            console.warn("ZIP creation error:", error);
                            toast.error(`Error creating ZIP file: ${error}`);
                            setIsDownloadingAll(false);
                        }
                        break;

                    case 'deleteFile':
                        if (success) {
                            toast.success(`File '${filename}' deleted successfully.`);
                            setIsDeletingFile(prev => ({ ...prev, [filename]: false }));
                            // Refresh datasets after deletion
                            getFileCountFromIndexedDB();
                        }
                        break;

                    case 'deleteAll':
                        if (success) {
                            toast.success(`All files deleted successfully.`);
                            setIsDeletingAll(false);
                            setDatasets([]);
                        }
                        break;
                }
            };
        }
    };

    const setSelectedChannelsInWorker = (selectedChannels: number[]) => {
        if (!workerRef.current) {
            initializeWorker();
        }

        // Send selectedChannels independently to the worker
        workerRef.current?.postMessage({
            action: 'setSelectedChannels',
            selectedChannels: selectedChannels,
        });
    };

    useEffect(() => {
        setSelectedChannelsInWorker(selectedChannels);
    }, [selectedChannels]);

    const processBuffer = async (bufferIndex: number, canvasCount: number, selectChannel: number[]): Promise<void> => {
        return new Promise((resolve) => {
            if (!workerRef.current) {
                initializeWorker();
            }

            // If the buffer is empty, return early
            if (recordingBuffers[bufferIndex].length === 0) {
                resolve();
                return;
            }

            const data = recordingBuffers[bufferIndex];
            const filename = currentFileNameRef.current;

            if (filename) {
                const handleMessage = (event: MessageEvent) => {
                    const { action: msgAction, success: msgSuccess, filename: completedFilename } = event.data;
                    if (msgAction === 'writeComplete' && completedFilename === filename) {
                        workerRef.current?.removeEventListener('message', handleMessage);
                        resolve();
                    }
                };

                workerRef.current?.addEventListener('message', handleMessage);
                workerRef.current?.postMessage({
                    action: 'write',
                    data,
                    filename,
                    header: csvHeaderRef.current,
                    canvasCount,
                    selectChannel
                });
            } else {
                resolve();
            }
        });
    };

    const saveAllDataAsZip = async () => {
        try {
            setIsDownloadingAll(true);
            if (workerRef.current) {
                workerRef.current.postMessage({
                    action: 'saveAsZip',
                    canvasElementCount: canvasElementCountRef.current,
                    selectedChannels
                });
            }
        } catch (error) {
            console.warn('Error while saving ZIP file:', error);
            toast.error('Error creating ZIP file');
            setIsDownloadingAll(false);
        }
    };

    // Function to handle saving data by filename
    const saveDataByFilename = async (filename: string, canvasCount: number, selectChannel: number[]) => {
        if (workerRef.current) {
            setIsDownloadingFile(prev => ({ ...prev, [filename]: true }));
            workerRef.current.postMessage({
                action: "saveDataByFilename",
                filename,
                canvasCount,
                selectedChannels: selectChannel,
                selectChannel
            });
        } else {
            console.warn("Worker reference is null.");
            toast.error("Worker is not available.");
        }
    };

    const deleteFileByFilename = async (filename: string) => {
        if (!workerRef.current) initializeWorker();

        setIsDeletingFile(prev => ({ ...prev, [filename]: true }));
        workerRef.current?.postMessage({ action: 'deleteFile', filename });
    };

    const deleteAllDataFromIndexedDB = async () => {
        if (!workerRef.current) initializeWorker();

        setIsDeletingAll(true);
        workerRef.current?.postMessage({ action: 'deleteAll' });
    };

    const handleTimeSelection = (minutes: number | null) => {
        // Function to handle the time selection
        if (minutes === null) {
            endTimeRef.current = null;
            toast.success("Recording set to no time limit");
        } else {
            // If the time is not null, set the end time
            const newEndTimeSeconds = minutes * 60 * 1000;
            if (newEndTimeSeconds <= recordingElapsedTime) {
                // Check if the end time is greater than the current elapsed time
                toast.error("End time must be greater than the current elapsed time");
            } else {
                endTimeRef.current = newEndTimeSeconds; // Set the end time
                toast.success(`Recording end time set to ${minutes} minutes`);
            }
        }
    };

    const handleRecord = async () => {
        if (isRecordingRef.current) {
            // Stop the recording if it is currently active
            await stopRecording();
        } else {
            // Start a new synchronized recording session
            isRecordingRef.current = true;
            const now = new Date();
            recordingStartTimeRef.current = Date.now();
            recordingStartPerfRef.current = performance.now();
            totalSamplesRecordedRef.current = 0;
            pendingRREventsRef.current = [];
            setRecordingElapsedTime(0);
            setIsrecord(false);
            const filename = `ChordsWeb-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-` +
                `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}.csv`;

            currentFileNameRef.current = filename;

            const sessionFormatted = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_` +
                `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
            sessionMetricsManager.startSession(sessionFormatted);

            // Configure CSV header
            if (isPolarConnectedRef.current) {
                csvHeaderRef.current = [
                    "Timestamp_ms",
                    "Elapsed_s",
                    "Counter",
                    ...selectedChannelsRef.current.map((ch) => `Channel${ch}`),
                    "HeartRate_BPM",
                    "RR_Interval_ms"
                ];
                toast.success("Recording started (NPG + Polar HRV synchronized)");
            } else {
                csvHeaderRef.current = [
                    "Timestamp_ms",
                    "Elapsed_s",
                    "Counter",
                    ...selectedChannelsRef.current.map((ch) => `Channel${ch}`)
                ];
                toast.success("Recording started");
            }
        }
    };

    const stopRecording = async () => {
        if (!recordingStartTimeRef.current) {
            toast.error("Recording start time was not captured.");
            return;
        }

        isRecordingRef.current = false;
        setRecordingElapsedTime(0);
        setIsrecord(true);
        setIsProcessingRecording(true);
        pendingRREventsRef.current = [];

        recordingStartTimeRef.current = 0;
        recordingStartPerfRef.current = 0;
        totalSamplesRecordedRef.current = 0;
        existingRecordRef.current = undefined;

        // Process any remaining data in the buffer
        if (fillingindex.current > 0) {
            // Create a copy of the current buffer data
            const remainingData = recordingBuffers[activeBufferIndex].slice(0, fillingindex.current);
            recordingBuffers[activeBufferIndex] = remainingData;

            // Process the remaining buffer
            await processBuffer(activeBufferIndex, canvasElementCountRef.current, selectedChannels);
        }

        // Export and automatically download separate HRV and Focus CSVs
        const exportResult = sessionMetricsManager.finishSession(workerRef.current);

        // Clear buffers after processing
        recordingBuffers.forEach(buffer => buffer.length = 0);
        activeBufferIndex = 0;
        fillingindex.current = 0;

        // Fetch updated datasets
        await getFileCountFromIndexedDB();

        setIsProcessingRecording(false);
        const downloadedFiles = [exportResult.hrvFilename, exportResult.focusFilename].filter(Boolean);
        if (downloadedFiles.length > 0) {
            toast.success(`Recording complete! Downloaded ${downloadedFiles.join(" and ")}`);
        } else {
            toast.success("Recording saved successfully!");
        }
    };

    const getFileCountFromIndexedDB = async (): Promise<void> => {
        if (!workerRef.current) {
            initializeWorker();
        }

        workerRef.current?.postMessage({ action: 'getFileCountFromIndexedDB' });
    };

    // Initial load of datasets
    useEffect(() => {
        getFileCountFromIndexedDB();
    }, []);

    const handlecustomTimeInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        // Update custom time input with only numeric values
        setCustomTimeInput(e.target.value.replace(/\D/g, ""));
    };

    const handlecustomTimeInputSet = () => {
        // Parse and validate the custom time input
        const time = parseInt(customTimeInput, 10);

        if (time > 0) {
            handleTimeSelection(time); // Proceed with valid time
        } else {
            toast.error("Please enter a valid time in minutes"); // Show error for invalid input
        }

        // Clear the input field after handling
        setCustomTimeInput("");
    };

    const formatTime = (milliseconds: number): string => {
        const date = new Date(milliseconds);
        const hours = String(date.getUTCHours()).padStart(2, '0');
        const minutes = String(date.getUTCMinutes()).padStart(2, '0');
        const seconds = String(date.getUTCSeconds()).padStart(2, '0');
        return `${hours}:${minutes}:${seconds}`;
    };

    useEffect(() => {
        const enabledChannels = Array.from({ length: deviceConfig.maxChannels }, (_, i) => i + 1);

        const allSelected = selectedChannels.length === enabledChannels.length;
        const onlyOneLeft = selectedChannels.length === enabledChannels.length - 1;

        setIsSelectAllDisabled((allSelected && manuallySelected) || onlyOneLeft);

        // Update the "Select All" button state
        setIsAllEnabledChannelSelected(allSelected);
    }, [selectedChannels, deviceConfig.maxChannels, manuallySelected, refreshKey]);

    const toggleChannel = (channelIndex: number) => {
        setSelectedChannels((prevSelected) => {
            setManuallySelected(true);
            const updatedChannels = prevSelected.includes(channelIndex)
                ? prevSelected.filter((ch) => ch !== channelIndex)
                : [...prevSelected, channelIndex];

            const sortedChannels = updatedChannels.sort((a, b) => a - b);

            if (sortedChannels.length === 0) {
                sortedChannels.push(1);
            }

            return sortedChannels;
        });
    };

    const updatePlots = useCallback(
        (data: number[], Zoom: number) => {
            // Access the latest selectedChannels via the ref
            setIsLoading(false);
            setIsConnected(true);
            const currentSelectedChannels = selectedChannelsRef.current;
            // Adjust zoom level for each WebglPlot
            wglPlots.forEach((wglp, index) => {
                if (wglp) {
                    try {
                        wglp.gScaleY = zoomRef.current; // Adjust zoom value
                    } catch (error) {
                        console.warn(
                            `Error setting gScaleY for WebglPlot instance at index ${index}:`,
                            error
                        );
                    }
                } else {
                    console.warn(`WebglPlot instance at index ${index} is undefined.`);
                }
            });

            linesRef.current.forEach((line, i) => {
                if (!line) {
                    console.warn(`Line at index ${i} is undefined.`);
                    return;
                }

                // Map channel number from selectedChannels
                const channelNumber = currentSelectedChannels[i];
                if (channelNumber == null || channelNumber < 0 || channelNumber >= data.length) {
                    console.warn(`Invalid channel number: ${channelNumber}. Skipping.`);
                    return;
                }

                const channelData = data[channelNumber];

                // Ensure sweepPositions.current[i] is initialized
                if (sweepPositions.current[i] === undefined) {
                    sweepPositions.current[i] = 0;
                }

                // Calculate the current position
                const currentPos = sweepPositions.current[i] % line.numPoints;

                if (Number.isNaN(currentPos)) {
                    console.warn(`Invalid currentPos at index ${i}. sweepPositions.current[i]:`, sweepPositions.current[i]);
                    return;
                }

                // Plot the data
                try {
                    line.setY(currentPos, channelData);
                } catch (error) {
                    console.warn(`Error plotting data for line ${i} at position ${currentPos}:`, error);
                }

                // Clear the next point for visual effect
                const clearPosition = Math.ceil((currentPos + dataPointCountRef.current / 100) % line.numPoints);
                try {
                    line.setY(clearPosition, NaN);
                } catch (error) {
                    console.warn(`Error clearing data at position ${clearPosition} for line ${i}:`, error);
                }

                // Increment the sweep position
                sweepPositions.current[i] = (currentPos + 1) % line.numPoints;
            });

            // Advance Polar Rate channel synchronously with EXG samples
            if (showPolarChannelRef.current && polarLineRef.current) {
                plotPolarPoint(latestHeartRateRef.current);
            }
        },
        [linesRef, wglPlots, selectedChannelsRef, dataPointCountRef.current, sweepPositions, Zoom, zoomRef.current, timeBase, plotPolarPoint]
    );

    useEffect(() => {
        const handleResize = () => {
            createCanvasElements();
        };
        window.addEventListener("resize", handleResize);
        return () => {
            window.removeEventListener("resize", handleResize);
        };
    }, [createCanvasElements]);

    const animate = useCallback(() => {
        if (pauseRef.current) {
            // If paused, show the buffered data (this part runs when paused)
            wglPlots.forEach((wglp) => wglp.update());
            requestAnimationFrame(animate); // Continue the animation loop
        }
    }, [wglPlots, pauseRef.current]);

    useEffect(() => {
        requestAnimationFrame(animate);
    }, [animate, Zoom]);

    // Function to get battery icon based on level
    const getBatteryIcon = (level: number | null) => {
        if (level === null) return <BatteryWarning size={30} />;

        if (level <= 10) return <Battery
            size={30}
            className="text-red-500 animate-blink"
        />;
        if (level <= 20.0 && level > 10.0) return <BatteryLow size={30} />;
        if (level <= 70.0 && level > 20.0) return <BatteryMedium size={30} />;
        if (level > 70) return <BatteryFull size={30} />;
        return <BatteryFull size={30} />;
    };

    useEffect(() => {
        if (batteryLevel === null) return;

        let intervalId: number | undefined;

        // Handle battery level checks
        if (batteryLevel <= 10) {
            // Show immediate notification
            toast.error("Very low battery! Please recharge immediately.");

            // Set up interval to show notification every minute
            intervalId = window.setInterval(() => {
                toast.error("Very low battery! Please recharge immediately.");
            }, 60000); // 60000ms = 1 minute

        } else if (batteryLevel === 20) {
            toast.warning("Battery is low at " + batteryLevel + "%. Consider recharging soon.");
        } else if (batteryLevel === 70) {
            toast.success("Battery level is " + batteryLevel + "%.");
        } else if (batteryLevel === 99) {
            toast.success("Battery fully charged.");
        }

        // Cleanup function to clear interval when batteryLevel changes or component unmounts
        return () => {
            if (intervalId) {
                clearInterval(intervalId);
            }
        };
    }, [batteryLevel]);

    // Function to get battery color based on level
    const getBatteryColor = (level: number | null) => {
        if (level === null) return "text-red-500";

        if (level <= 20.0 && level > 10.0) return "text-red-500";
        if (level <= 70.0 && level > 20.0) return "text-orange-500";
        if (level > 70) return "text-green-500";
        return "text-green-500";
    };

    return (
        <div className="flex flex-col h-screen m-0 p-0 bg-g ">
            <div className="bg-highlight">
                <Navbar isDisplay={true} />
            </div>
            <main className=" flex flex-col flex-[1_1_0%] min-h-80 bg-highlight  rounded-2xl m-4 relative"
                ref={canvasContainerRef}
            >
            </main>
            <div className="flex-none items-center justify-center pb-4 bg-g z-10" >
                {/* Left-aligned section */}
                <div className="absolute left-4 flex items-center mx-0 px-0 space-x-1">
                    {isRecordingRef.current && (
                        <div className="flex items-center space-x-1 w-min">
                            <button className="flex items-center justify-center px-1 py-2   select-none min-w-20 bg-primary text-destructive whitespace-nowrap rounded-xl"
                            >
                                {formatTime(recordingElapsedTime)}
                            </button>
                            <Separator orientation="vertical" className="bg-primary h-9 " />
                            <div>
                                <Popover
                                    open={isEndTimePopoverOpen}
                                    onOpenChange={setIsEndTimePopoverOpen}
                                >
                                    <PopoverTrigger asChild>
                                        <Button
                                            className="flex items-center justify-center px-1 py-2   select-none min-w-10  text-destructive whitespace-nowrap rounded-xl"
                                            variant="destructive"
                                        >
                                            {endTimeRef.current === null ? (
                                                <Infinity className="h-5 w-5 text-primary" />
                                            ) : (
                                                <div className="text-sm text-primary font-medium">
                                                    {formatTime(endTimeRef.current)}
                                                </div>
                                            )}
                                        </Button>
                                    </PopoverTrigger>
                                    <PopoverContent className="w-64 p-4 mx-4">
                                        <div className="flex flex-col space-y-4">
                                            <div className="text-sm font-medium">
                                                Set End Time (minutes)
                                            </div>
                                            <div className="grid grid-cols-4 gap-2">
                                                {[1, 10, 20, 30].map((time) => (
                                                    <Button
                                                        key={time}
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => handleTimeSelection(time)}
                                                    >
                                                        {time}
                                                    </Button>
                                                ))}
                                            </div>
                                            <div className="flex space-x-2 items-center">
                                                <Input
                                                    type="text"
                                                    inputMode="numeric"
                                                    pattern="[0-9]*"
                                                    placeholder="Custom"
                                                    value={customTimeInput}
                                                    onBlur={handlecustomTimeInputSet}
                                                    onKeyDown={(e) =>
                                                        e.key === "Enter" && handlecustomTimeInputSet()
                                                    }
                                                    onChange={handlecustomTimeInputChange}
                                                    className="w-20"
                                                />
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    onClick={() => handleTimeSelection(null)}
                                                >
                                                    <Infinity className="h-4 w-4" />
                                                </Button>
                                            </div>
                                        </div>
                                    </PopoverContent>
                                </Popover>
                            </div>
                        </div>
                    )}
                </div>

                {/* Center-aligned buttons */}
                <div className="flex gap-3 items-center justify-center">
                    {/* Connection button with tooltip */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Popover open={open} onOpenChange={setOpen}>
                                    <PopoverTrigger asChild>
                                        <Button
                                            className="flex items-center gap-1 py-2 px-4 rounded-xl font-semibold"
                                            onClick={() => (isConnected ? disconnect() : connectBLE())}
                                            disabled={isLoading}
                                        >
                                            {isLoading ? (
                                                <>
                                                    <Loader size={17} className="animate-spin" />
                                                    Connecting...
                                                </>
                                            ) : isConnected ? (
                                                <>
                                                    Disconnect
                                                    <CircleX size={17} />
                                                </>
                                            ) : (
                                                <>
                                                    Connect
                                                </>
                                            )}
                                        </Button>
                                    </PopoverTrigger>
                                </Popover>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{isConnected ? "Disconnect Device" : "Connect Device"}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {/* Polar HRV Sensor Connection & Status */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                {isPolarConnected ? (
                                    <Popover open={isPolarPopoverOpen} onOpenChange={setIsPolarPopoverOpen}>
                                        <PopoverTrigger asChild>
                                            <Button
                                                className="flex items-center gap-1.5 py-2 px-3 rounded-xl font-semibold bg-rose-600 hover:bg-rose-700 text-white shadow-sm"
                                            >
                                                <Heart size={16} className="text-white fill-white animate-pulse" />
                                                <span className="text-sm font-bold">
                                                    {polarHeartRate !== null ? `${polarHeartRate} BPM` : "Polar Connected"}
                                                </span>
                                            </Button>
                                        </PopoverTrigger>
                                        <PopoverContent className="w-64 p-4 shadow-xl rounded-xl space-y-3 z-50">
                                            <div className="flex items-center justify-between border-b pb-2">
                                                <div className="flex items-center gap-2">
                                                    <Heart size={18} className="text-rose-500 fill-rose-500 animate-pulse" />
                                                    <span className="font-semibold text-sm truncate max-w-[140px]">{polarDeviceName}</span>
                                                </div>
                                                {polarBattery !== null && (
                                                    <span className="text-xs bg-muted px-2 py-0.5 rounded-full font-medium">
                                                        {polarBattery}%
                                                    </span>
                                                )}
                                            </div>
                                            <div className="grid grid-cols-2 gap-2 text-sm">
                                                <div className="bg-muted/50 p-2 rounded-lg">
                                                    <div className="text-xs text-muted-foreground">Heart Rate</div>
                                                    <div className="text-lg font-bold text-rose-500">
                                                        {polarHeartRate !== null ? `${polarHeartRate} BPM` : "--"}
                                                    </div>
                                                </div>
                                                <div className="bg-muted/50 p-2 rounded-lg">
                                                    <div className="text-xs text-muted-foreground">Last RR</div>
                                                    <div className="text-lg font-bold">
                                                        {polarLastRR !== null ? `${polarLastRR} ms` : "--"}
                                                    </div>
                                                </div>
                                            </div>
                                            {polarRmssd !== null && (
                                                <div className="bg-muted/40 p-2 rounded-lg text-xs space-y-1">
                                                    <div className="flex justify-between items-center">
                                                        <span className="text-muted-foreground font-medium">RMSSD (HRV):</span>
                                                        <span className="font-bold text-rose-500">{polarRmssd} ms</span>
                                                    </div>
                                                    {polarHrvState && (
                                                        <div className="text-[11px] font-medium text-foreground truncate">
                                                            {polarHrvState}
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                            <Button
                                                variant="destructive"
                                                size="sm"
                                                className="w-full rounded-lg"
                                                onClick={() => {
                                                    handleDisconnectPolar();
                                                    setIsPolarPopoverOpen(false);
                                                }}
                                            >
                                                Disconnect Polar
                                            </Button>
                                        </PopoverContent>
                                    </Popover>
                                ) : (
                                    <div className="flex items-center gap-1">
                                        <Button
                                            variant="outline"
                                            className="flex items-center gap-1.5 py-2 px-3 rounded-xl font-semibold border-rose-400 hover:border-rose-500 hover:bg-rose-50/10 text-rose-500"
                                            onClick={() => handleConnectPolar(false)}
                                            disabled={isPolarConnecting}
                                        >
                                            {isPolarConnecting ? (
                                                <>
                                                    <Loader2 size={16} className="animate-spin text-rose-400" />
                                                    <span className="text-sm">Connecting Polar...</span>
                                                </>
                                            ) : (
                                                <>
                                                    <Heart size={16} className="text-rose-500" />
                                                    <span className="text-sm">Connect Polar HRV</span>
                                                </>
                                            )}
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="px-2.5 h-9 rounded-xl border-rose-300/60 hover:bg-rose-50/20 text-rose-500 text-xs font-semibold"
                                            onClick={() => handleConnectPolar(true)}
                                            disabled={isPolarConnecting}
                                            title="Can't find your sensor? Scan all Bluetooth devices"
                                        >
                                            Scan All
                                        </Button>
                                    </div>
                                )}
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{isPolarConnected ? `${polarDeviceName} (Click for details)` : "Connect Polar HRV Sensor via Bluetooth"}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {/* Polar Rate Channel Toggle Button */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant={showPolarChannel ? "default" : "outline"}
                                    size="sm"
                                    className={`flex items-center gap-1.5 py-2 px-3 rounded-xl font-semibold border transition-all h-9 ${
                                        showPolarChannel
                                            ? "bg-rose-600 hover:bg-rose-700 text-white border-rose-500 shadow-sm"
                                            : "border-rose-400/60 hover:bg-rose-50/10 text-rose-500"
                                    }`}
                                    onClick={() => setShowPolarChannel((prev) => !prev)}
                                >
                                    <Heart size={15} className={showPolarChannel ? "fill-white text-white" : "text-rose-500"} />
                                    <span className="text-xs font-bold">
                                        {showPolarChannel ? "Polar CH ON" : "Polar CH OFF"}
                                    </span>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{showPolarChannel ? "Hide Polar Rates Channel" : "Show Polar Rates Channel"}</p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    <div className="flex items-center gap-0.5 mx-0 px-0">
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button className="rounded-xl " onClick={togglePause} disabled={isConnected == false || !isRecord}
                                    >
                                        {isDisplay ? (
                                            <Pause className="h-5 w-5" />
                                        ) : (
                                            <Play className="h-5 w-5" />
                                        )}
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>
                                        {isDisplay ? "Pause Data Display" : "Resume Data Display"}
                                    </p>
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    </div>

                    {/* Record button with tooltip */}
                    <TooltipProvider>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    className="rounded-xl"
                                    onClick={handleRecord}
                                    disabled={isConnected == false || !isDisplay || isProcessingRecording}
                                >
                                    {isProcessingRecording ? (
                                        <Loader2 className="animate-spin" />
                                    ) : isRecordingRef.current ? (
                                        <CircleStop />
                                    ) : (
                                        <Circle fill="red" />
                                    )}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>
                                    {isProcessingRecording
                                        ? "Saving recording..."
                                        : !isRecordingRef.current
                                            ? "Start Recording"
                                            : "Stop Recording"}
                                </p>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>

                    {/* Save/Delete data buttons with tooltip */}
                    <TooltipProvider>
                        <div className="flex">
                            <Popover>
                                <PopoverTrigger asChild>
                                    <Button className="rounded-xl p-4">
                                        <FileArchive size={16} />
                                    </Button>
                                </PopoverTrigger>
                                <PopoverContent className="p-4 text-base shadow-lg rounded-xl w-full">
                                    <div className="space-y-4">
                                        {/* Processing indicator for recording */}
                                        {isProcessingRecording && (
                                            <div className="flex items-center justify-center space-x-2 p-2 bg-yellow-100 dark:bg-yellow-900/30 rounded-lg">
                                                <Loader2 className="animate-spin h-4 w-4" />
                                                <span className="text-sm">Saving recording...</span>
                                            </div>
                                        )}

                                        {/* List each file with download and delete actions */}
                                        {datasets.length > 0 ? (
                                            datasets.map((dataset) => (
                                                <div key={dataset} className="flex justify-between items-center">
                                                    <span className="mr-4" title={dataset}>
                                                        {dataset}
                                                    </span>

                                                    <div className="flex space-x-2">
                                                        {/* Save file by filename */}
                                                        <Button
                                                            onClick={() => saveDataByFilename(dataset, canvasElementCountRef.current, selectedChannels)}
                                                            className="rounded-xl px-4"
                                                            disabled={isDownloadingFile[dataset]}
                                                            size="sm"
                                                        >
                                                            {isDownloadingFile[dataset] ? (
                                                                <Loader2 className="animate-spin h-4 w-4" />
                                                            ) : (
                                                                <Download size={16} />
                                                            )}
                                                        </Button>

                                                        {/* Delete file by filename */}
                                                        <Button
                                                            onClick={() => deleteFileByFilename(dataset)}
                                                            className="rounded-xl px-4"
                                                            disabled={isDeletingFile[dataset]}

                                                        >
                                                            {isDeletingFile[dataset] ? (
                                                                <Loader2 className="animate-spin h-4 w-4" />
                                                            ) : (
                                                                <Trash2 size={16} />
                                                            )}
                                                        </Button>
                                                    </div>
                                                </div>
                                            ))
                                        ) : (
                                            <p className="text-base">No datasets available</p>
                                        )}

                                        {/* Download all as ZIP and delete all options */}
                                        {datasets.length > 0 && (
                                            <div className="flex justify-between mt-4">
                                                <Button
                                                    onClick={saveAllDataAsZip}
                                                    className="rounded-xl p-2 w-full mr-2"
                                                    disabled={isDownloadingAll || isDeletingAll}
                                                    size="sm"
                                                >
                                                    {isDownloadingAll ? (
                                                        <>
                                                            <Loader2 className="animate-spin h-4 w-4 mr-2" />
                                                            Creating ZIP...
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Download size={16} className="mr-2" />
                                                            Download All as Zip
                                                        </>
                                                    )}
                                                </Button>
                                                <Button
                                                    onClick={deleteAllDataFromIndexedDB}
                                                    className="rounded-xl p-2 w-full"
                                                    disabled={isDeletingAll || isDownloadingAll}

                                                >
                                                    {isDeletingAll ? (
                                                        <>
                                                            <Loader2 className="animate-spin h-4 w-4 mr-2" />
                                                            Deleting...
                                                        </>
                                                    ) : (
                                                        <>
                                                            <Trash2 size={16} className="mr-2" />
                                                            Delete All
                                                        </>
                                                    )}
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                </PopoverContent>
                            </Popover>
                        </div>
                    </TooltipProvider>

                    {/* filters */}
                    <Popover
                        open={isFilterPopoverOpen}
                        onOpenChange={setIsFilterPopoverOpen}
                    >
                        <PopoverTrigger asChild>
                            <Button
                                className="flex items-center justify-center px-3 py-2 select-none min-w-12 whitespace-nowrap rounded-xl"
                                disabled={!isDisplay}
                            >
                                Filter
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-50 p-4 mx-4 mb-2">
                            <div className="flex flex-col max-h-80 overflow-y-auto">
                                <div className="flex items-center pb-2 ">
                                    {/* Filter Name */}
                                    <div className="text-sm font-semibold w-12"><ReplaceAll size={20} /></div>
                                    {/* Buttons */}
                                    <div className="flex space-x-2">
                                        <div className="flex items-center border border-input rounded-xl mx-0 px-0">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => removeEXGFilterFromAllChannels(Array.from({ length: deviceConfig.maxChannels }, (_, i) => i))}
                                                className={`rounded-xl rounded-r-none border-0
                        ${Object.keys(appliedEXGFiltersRef.current).length === 0
                                                        ? "bg-red-700 hover:bg-white-500 hover:text-white text-white" // Disabled background
                                                        : "bg-white-500" // Active background
                                                    }`}
                                            >
                                                <CircleOff size={17} />
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => applyEXGFilterToAllChannels(Array.from({ length: deviceConfig.maxChannels }, (_, i) => i), 4)}
                                                className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0
                        ${Object.keys(appliedEXGFiltersRef.current).length === deviceConfig.maxChannels && Object.values(appliedEXGFiltersRef.current).every((value) => value === 4)
                                                        ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" // Disabled background
                                                        : "bg-white-500" // Active background
                                                    }`}
                                            >
                                                <BicepsFlexed size={17} />
                                            </Button> <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => applyEXGFilterToAllChannels(Array.from({ length: deviceConfig.maxChannels }, (_, i) => i), 3)}
                                                className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0
                        ${Object.keys(appliedEXGFiltersRef.current).length === deviceConfig.maxChannels && Object.values(appliedEXGFiltersRef.current).every((value) => value === 3)
                                                        ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" // Disabled background
                                                        : "bg-white-500" // Active background
                                                    }`}
                                            >
                                                <Brain size={17} />
                                            </Button> <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => applyEXGFilterToAllChannels(Array.from({ length: deviceConfig.maxChannels }, (_, i) => i), 1)}
                                                className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0
                        ${Object.keys(appliedEXGFiltersRef.current).length === deviceConfig.maxChannels && Object.values(appliedEXGFiltersRef.current).every((value) => value === 1)
                                                        ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" // Disabled background
                                                        : "bg-white-500" // Active background
                                                    }`}
                                            >
                                                <Heart size={17} />
                                            </Button> <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => applyEXGFilterToAllChannels(Array.from({ length: deviceConfig.maxChannels }, (_, i) => i), 2)}
                                                className={`rounded-xl rounded-l-none border-0
                        ${Object.keys(appliedEXGFiltersRef.current).length === deviceConfig.maxChannels && Object.values(appliedEXGFiltersRef.current).every((value) => value === 2)
                                                        ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" // Disabled background
                                                        : "bg-white-500" // Active background
                                                    }`}
                                            >
                                                <Eye size={17} />
                                            </Button>
                                        </div>
                                        <div className="flex border border-input rounded-xl items-center mx-0 px-0">
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => removeNotchFromAllChannels(Array.from({ length: deviceConfig.maxChannels }, (_, i) => i))}
                                                className={`rounded-xl rounded-r-none border-0
                          ${Object.keys(appliedFiltersRef.current).length === 0
                                                        ? "bg-red-700 hover:bg-white-500 hover:text-white text-white" // Disabled background
                                                        : "bg-white-500" // Active background
                                                    }`}
                                            >
                                                <CircleOff size={17} />
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => applyFilterToAllChannels(Array.from({ length: deviceConfig.maxChannels }, (_, i) => i), 1)}
                                                className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0
                          ${Object.keys(appliedFiltersRef.current).length === deviceConfig.maxChannels && Object.values(appliedFiltersRef.current).every((value) => value === 1)
                                                        ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" // Disabled background
                                                        : "bg-white-500" // Active background
                                                    }`}
                                            >
                                                50Hz
                                            </Button>
                                            <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() => applyFilterToAllChannels(Array.from({ length: deviceConfig.maxChannels }, (_, i) => i), 2)}
                                                className={`rounded-xl rounded-l-none border-0
                          ${Object.keys(appliedFiltersRef.current).length === deviceConfig.maxChannels && Object.values(appliedFiltersRef.current).every((value) => value === 2)
                                                        ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" // Disabled background
                                                        : "bg-white-500" // Active background
                                                    }`}
                                            >
                                                60Hz
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                                <div className="flex flex-col space-y-2">
                                    {channelNames.map((filterName, index) => (
                                        <div key={filterName} className="flex items-center">
                                            {/* Filter Name */}
                                            <div className="text-sm font-semibold w-12">{filterName}</div>
                                            {/* Buttons */}
                                            <div className="flex space-x-2">
                                                <div className="flex border border-input rounded-xl items-center mx-0 px-0">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => removeEXGFilter(index)}
                                                        className={`rounded-xl rounded-r-none border-l-none border-0
                                                        ${appliedEXGFiltersRef.current[index] === undefined
                                                                ? "bg-red-700 hover:bg-white-500 hover:text-white text-white" // Disabled background
                                                                : "bg-white-500" // Active background
                                                            }`}
                                                    >
                                                        <CircleOff size={17} />
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => handleFrequencySelectionEXG(index, 4)}
                                                        className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0
                                                        ${appliedEXGFiltersRef.current[index] === 4
                                                                ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" // Disabled background
                                                                : "bg-white-500" // Active background
                                                            }`}
                                                    >
                                                        <BicepsFlexed size={17} />
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => handleFrequencySelectionEXG(index, 3)}
                                                        className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0
                                                      ${appliedEXGFiltersRef.current[index] === 3
                                                                ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" // Disabled background
                                                                : "bg-white-500" // Active background
                                                            }`}
                                                    >
                                                        <Brain size={17} />
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => handleFrequencySelectionEXG(index, 1)}
                                                        className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0
                                                        ${appliedEXGFiltersRef.current[index] === 1
                                                                ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" // Disabled background
                                                                : "bg-white-500" // Active background
                                                            }`}
                                                    >
                                                        <Heart size={17} />
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => handleFrequencySelectionEXG(index, 2)}
                                                        className={`rounded-xl rounded-l-none border-0
                                                        ${appliedEXGFiltersRef.current[index] === 2
                                                                ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" // Disabled background
                                                                : "bg-white-500" // Active background
                                                            }`}
                                                    >
                                                        <Eye size={17} />
                                                    </Button>
                                                </div>
                                                <div className="flex border border-input rounded-xl items-center mx-0 px-0">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => removeNotchFilter(index)}
                                                        className={`rounded-xl rounded-r-none border-0
                                                        ${appliedFiltersRef.current[index] === undefined
                                                                ? "bg-red-700 hover:bg-white-500 hover:text-white text-white" // Disabled background
                                                                : "bg-white-500" // Active background
                                                            }`}
                                                    >
                                                        <CircleOff size={17} />
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => handleFrequencySelection(index, 1)}
                                                        className={`flex items-center justify-center px-3 py-2 rounded-none select-none border-0
                                                        ${appliedFiltersRef.current[index] === 1
                                                                ? "bg-green-700 hover:bg-white-500 text-white hover:text-white" // Disabled background
                                                                : "bg-white-500" // Active background
                                                            }`}
                                                    >
                                                        50Hz
                                                    </Button>
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => handleFrequencySelection(index, 2)}
                                                        className={
                                                            `rounded-xl rounded-l-none border-0 ${appliedFiltersRef.current[index] === 2
                                                                ? "bg-green-700 hover:bg-white-500 text-white hover:text-white "
                                                                : "bg-white-500 animate-fade-in-right"
                                                            }`
                                                        }
                                                    >
                                                        60Hz
                                                    </Button>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </PopoverContent>
                    </Popover>
                    <Popover>
                        <PopoverTrigger asChild>
                            <Button className="flex items-center justify-center select-none whitespace-nowrap rounded-xl">
                                <Settings size={16} />
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-[30rem] p-4 mx-4 mb-2 rounded-md shadow-md text-sm">
                            <TooltipProvider>
                                <div className={`space-y-6 ${!isDisplay ? "flex justify-center" : ""}`}>
                                    {/* Channel Selection */}
                                    {(isDisplay && isRecord) && (
                                        <div className="flex items-center justify-center rounded-lg mb-[2.5rem]">
                                            <div className=" w-full">
                                                <div className="absolute inset-0 rounded-lg border-gray-300 dark:border-gray-600 opacity-50 pointer-events-none"></div>
                                                <div className="relative">
                                                    {/* Heading and Select All Button */}
                                                    <div className="flex items-center justify-between mb-4">
                                                        <h3 className="text-xs font-semibold text-gray-500">
                                                            <span className="font-bold text-gray-600">Channels Count:</span> {selectedChannels.length}
                                                        </h3>
                                                        {
                                                            !(selectedChannels.length === deviceConfig.maxChannels && manuallySelected) && (
                                                                <button
                                                                    onClick={handleSelectAllToggle}
                                                                    className={`px-4 py-1 text-xs font-light rounded-lg transition ${isSelectAllDisabled
                                                                        ? "text-gray-400 bg-gray-200 dark:bg-gray-700 dark:text-gray-500 cursor-not-allowed"
                                                                        : "text-white bg-black hover:bg-gray-700 dark:bg-white dark:text-black dark:border dark:border-gray-500 dark:hover:bg-primary/70"
                                                                        }`}
                                                                    disabled={isSelectAllDisabled}
                                                                >
                                                                    {isAllEnabledChannelSelected ? "RESET" : "Select All"}
                                                                </button>
                                                            )
                                                        }
                                                    </div>
                                                    {/* Button Grid */}
                                                    <div id="button-container" className="relative space-y-2 rounded-lg">
                                                        {Array.from({ length: 1 }).map((_, container) => (
                                                            <div key={container} className="grid grid-cols-8 gap-2">
                                                                {Array.from({ length: deviceConfig.maxChannels }).map((_, col) => {
                                                                    const index = container * 8 + col;
                                                                    const isChannelDisabled = index >= deviceConfig.maxChannels;
                                                                    const isSelected = selectedChannels.includes(index + 1);

                                                                    // For selected channels, use the shared custom color.
                                                                    // Otherwise, use default styles.
                                                                    const buttonStyle = isChannelDisabled
                                                                        ? isDarkModeEnabled
                                                                            ? { backgroundColor: "#030c21", color: "gray" }
                                                                            : { backgroundColor: "#e2e8f0", color: "gray" }
                                                                        : isSelected
                                                                            ? { backgroundColor: getCustomColor(index, activeTheme), color: "white" }
                                                                            : { backgroundColor: "white", color: "black" };

                                                                    // Optional: calculate rounded corners based on button position.
                                                                    const isFirstInRow = col === 0;
                                                                    const isLastInRow = col === 7;
                                                                    const isFirstContainer = container === 0;
                                                                    const isLastContainer = container === 1;
                                                                    const roundedClass = `
                                   ${isFirstInRow && isFirstContainer ? "rounded-tl-lg" : ""} 
                                   ${isLastInRow && isFirstContainer ? "rounded-tr-lg" : ""} 
                                   ${isFirstInRow && isLastContainer ? "rounded-bl-lg" : ""} 
                                   ${isLastInRow && isLastContainer ? "rounded-br-lg" : ""}
                                 `;

                                                                    return (
                                                                        <button
                                                                            key={index}
                                                                            onClick={() => !isChannelDisabled && toggleChannel(index + 1)}
                                                                            disabled={isChannelDisabled}
                                                                            style={buttonStyle}
                                                                            className={`w-full h-8 text-xs font-medium py-1 border border-gray-300 dark:border-gray-600 transition-colors duration-200 ${roundedClass}`}
                                                                        >
                                                                            {`CH${index + 1}`}
                                                                        </button>
                                                                    );
                                                                })}
                                                            </div>
                                                        ))}
                                                    </div>

                                                    {/* Polar Rate Channel Toggle in Settings */}
                                                    <div className="flex items-center justify-between pt-3 mt-3 border-t border-gray-200 dark:border-gray-700">
                                                        <div className="flex items-center gap-2">
                                                            <Heart size={15} className="text-rose-500 fill-rose-500" />
                                                            <span className="text-xs font-semibold">Polar Rate Channel:</span>
                                                            {isPolarConnected && polarHeartRate !== null && (
                                                                <span className="text-[10px] bg-rose-500/10 text-rose-500 px-2 py-0.5 rounded-full font-bold">
                                                                    {polarHeartRate} BPM
                                                                </span>
                                                            )}
                                                        </div>
                                                        <button
                                                            onClick={() => setShowPolarChannel((prev) => !prev)}
                                                            className={`px-3 py-1 text-xs font-semibold rounded-lg border transition ${
                                                                showPolarChannel
                                                                    ? "bg-rose-600 text-white border-rose-500 hover:bg-rose-700"
                                                                    : "bg-muted text-muted-foreground border-border hover:bg-muted/80"
                                                            }`}
                                                        >
                                                            {showPolarChannel ? "Enabled" : "Disabled"}
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                    {/* Zoom Controls */}
                                    <div className={`relative w-full flex flex-col ${!isDisplay ? "" : "items-start"} text-sm`}>
                                        <p className="absolute top-[-1.2rem] left-0 text-xs font-semibold text-gray-500">
                                            <span className="font-bold text-gray-600">Zoom Level:</span> {Zoom}x
                                        </p>
                                        <div className="relative w-[28rem] flex items-center rounded-lg py-2 border border-gray-300 dark:border-gray-600 mb-4">
                                            {/* Button for setting Zoom to 1 */}
                                            <button
                                                className="text-gray-700 dark:text-gray-400 mx-1 px-2 py-1 border rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                                                onClick={() => SetZoom(1)}
                                            >
                                                1
                                            </button>

                                            <input
                                                type="range"
                                                min="1"
                                                max="10"
                                                value={Zoom}
                                                onChange={(e) => SetZoom(Number(e.target.value))}
                                                style={{
                                                    background: `linear-gradient(to right, rgb(101, 136, 205) ${((Zoom - 1) / 9) * 100}%, rgb(165, 165, 165) ${((Zoom - 1) / 9) * 11}%)`,
                                                }}
                                                className="flex-1 h-[0.15rem] rounded-full appearance-none bg-gray-800 focus:outline-none focus:ring-0 slider-input"
                                            />

                                            {/* Button for setting Zoom to 10 */}
                                            <button
                                                className="text-gray-700 dark:text-gray-400 mx-2 px-2 py-1 border rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                                                onClick={() => SetZoom(10)}
                                            >
                                                10
                                            </button>
                                            <style jsx>{` input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 15px; height: 15px;
                                                                 background-color: rgb(101, 136, 205); border-radius: 50%; cursor: pointer; } `}</style>
                                        </div>
                                    </div>

                                    {/* Time-Base Selection */}
                                    {isDisplay && (
                                        <div className="relative w-full flex flex-col items-start mt-3 text-sm">
                                            <p className="absolute top-[-1.2rem] left-0 text-xs font-semibold text-gray-500">
                                                <span className="font-bold text-gray-600">Time Base:</span> {timeBase} Seconds
                                            </p>
                                            <div className="relative w-[28rem] flex items-center rounded-lg py-2 border border-gray-300 dark:border-gray-600">
                                                {/* Button for setting Time Base to 1 */}
                                                <button
                                                    className="text-gray-700 dark:text-gray-400 mx-1 px-2 py-1 border rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                                                    onClick={() => setTimeBase(1)}
                                                >
                                                    1
                                                </button>
                                                <input
                                                    type="range"
                                                    min="1"
                                                    max="10"
                                                    value={timeBase}
                                                    onChange={(e) => setTimeBase(Number(e.target.value))}
                                                    style={{
                                                        background: `linear-gradient(to right, rgb(101, 136, 205) ${((timeBase - 1) / 9) * 100}%, rgb(165, 165, 165) ${((timeBase - 1) / 9) * 11}%)`,
                                                    }}
                                                    className="flex-1 h-[0.15rem] rounded-full appearance-none bg-gray-200 focus:outline-none focus:ring-0 slider-input"
                                                />
                                                {/* Button for setting Time Base to 10 */}
                                                <button
                                                    className="text-gray-700 dark:text-gray-400 mx-2 px-2 py-1 border rounded hover:bg-gray-200 dark:hover:bg-gray-700"
                                                    onClick={() => setTimeBase(10)}
                                                >
                                                    10
                                                </button>
                                                <style jsx>{` input[type="range"]::-webkit-slider-thumb { -webkit-appearance: none;appearance: none; width: 15px; height: 15px;
                                                                  background-color: rgb(101, 136, 205); border-radius: 50%; cursor: pointer; }`}</style>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </TooltipProvider>
                        </PopoverContent>
                    </Popover>
                    {/* Battery display when connected and has battery */}
                    <Popover>
                        <PopoverTrigger asChild>
                            <Button
                                className={
                                    `flex items-center justify-center select-none whitespace-nowrap rounded-lg ${getBatteryColor(batteryLevel)}`
                                }
                            >
                                {getBatteryIcon(batteryLevel)}
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-fit p-2 mb-2 rounded-md shadow-md text-sm">
                            {!isConnected ? (
                                <div className=" ">
                                    <p className="text-lg font-semibold">Device Not Connected!</p>
                                    <p className="text-sm">Please connect your device to view battery status.</p>
                                </div>
                            ) : (
                                <>
                                    {isOldfirmwareRef.current ? (
                                        <div className="mb-2 p-2">
                                            <p className="text-lg font-semibold">Old Firmware Detected</p>
                                            <p className="text-sm">
                                                Update firmware using <a
                                                    className="font-semibold text-blue-600 hover:underline"
                                                    href="https://upsidedownlabs.github.io/NPG-Lite-Flasher-Web"
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    NPG Lite Flasher
                                                </a>.
                                            </p>
                                        </div>
                                    ) : (
                                        <>
                                            {batteryLevel === null ? (
                                                <div className="p-1">
                                                    <p className="text-sm font-semibold">Calibrating...</p>
                                                </div>
                                            ) : (
                                                <div className="flex flex-col space-y-2">
                                                    <div className="flex items-center space-x-2">
                                                        {getBatteryIcon(batteryLevel)}
                                                        <span className="font-semibold">{batteryLevel}%</span>
                                                    </div>

                                                    {batteryLevel < 10 && (
                                                        <span className="text-sm text-red-500 animate-blink">
                                                            Low Battery
                                                        </span>
                                                    )}
                                                </div>
                                            )}
                                        </>
                                    )}
                                </>
                            )}
                        </PopoverContent>
                    </Popover>
                </div>
            </div>
        </div>
    );
}

export default NPG_Ble;