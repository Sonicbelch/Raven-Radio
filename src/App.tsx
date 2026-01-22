import { useEffect, useMemo, useRef, useState } from 'react';
import stationsData from './stations.json';

type Station = {
  id: string;
  name: string;
  country: string;
  tags: string[];
  url: string;
  codec: string;
  metadataUrl?: string;
};

type TalkKillerSettings = {
  enabled: boolean;
  speechSeconds: number;
  sensitivity: number;
  cooldownSeconds: number;
};

const stations = stationsData as Station[];

const defaultSettings: TalkKillerSettings = {
  enabled: true,
  speechSeconds: 6,
  sensitivity: 0.6,
  cooldownSeconds: 12
};

function useLocalStorage<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key);
    if (!stored) {
      return initialValue;
    }
    try {
      return JSON.parse(stored) as T;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}

function extractMetadata(data: unknown, stationName: string) {
  if (!data || typeof data !== 'object') {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.channels) && record.channels.length > 0) {
    const channel = record.channels[0] as Record<string, unknown>;
    if (typeof channel.lastPlaying === 'string') {
      return channel.lastPlaying;
    }
    if (typeof channel.title === 'string') {
      return channel.title;
    }
  }
  if (typeof record.now_playing === 'string') {
    return record.now_playing;
  }
  if (typeof record.title === 'string') {
    return record.title;
  }
  return `Streaming ${stationName}`;
}

function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const intervalRef = useRef<number | null>(null);
  const lastSwitchRef = useRef<number>(0);
  const speechSecondsRef = useRef<number>(0);

  const [currentId, setCurrentId] = useState(stations[0]?.id ?? '');
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<string | null>(null);
  const [analysisBlocked, setAnalysisBlocked] = useState(false);
  const [speechScore, setSpeechScore] = useState(0);
  const [speechLabel, setSpeechLabel] = useState('Music');

  const [favourites, setFavourites] = useLocalStorage<string[]>(
    'raven-radio:favourites',
    []
  );
  const [fallbacks, setFallbacks] = useLocalStorage<string[]>(
    'raven-radio:fallbacks',
    []
  );
  const [settings, setSettings] = useLocalStorage<TalkKillerSettings>(
    'raven-radio:settings',
    defaultSettings
  );

  const [query, setQuery] = useState('');
  const [countryFilter, setCountryFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');

  const currentStation = stations.find((station) => station.id === currentId);

  const countries = useMemo(() => {
    return Array.from(new Set(stations.map((station) => station.country))).sort();
  }, []);

  const tags = useMemo(() => {
    const tagSet = new Set<string>();
    stations.forEach((station) => station.tags.forEach((tag) => tagSet.add(tag)));
    return Array.from(tagSet).sort();
  }, []);

  const filteredStations = useMemo(() => {
    const lowered = query.trim().toLowerCase();
    return stations.filter((station) => {
      const matchesQuery =
        !lowered ||
        station.name.toLowerCase().includes(lowered) ||
        station.country.toLowerCase().includes(lowered) ||
        station.tags.some((tag) => tag.toLowerCase().includes(lowered));
      const matchesCountry = countryFilter === 'all' || station.country === countryFilter;
      const matchesTag = tagFilter === 'all' || station.tags.includes(tagFilter);
      return matchesQuery && matchesCountry && matchesTag;
    });
  }, [query, countryFilter, tagFilter]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentStation) {
      return;
    }
    audio.crossOrigin = 'anonymous';
    audio.src = currentStation.url;
    audio.load();
    setError(null);
    setAnalysisBlocked(false);
    setMetadata(null);
  }, [currentStation?.id]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleError = () => {
      setError('Stream failed to load. Try another station.');
      setIsPlaying(false);
    };

    audio.addEventListener('play', handlePlay);
    audio.addEventListener('pause', handlePause);
    audio.addEventListener('error', handleError);

    return () => {
      audio.removeEventListener('play', handlePlay);
      audio.removeEventListener('pause', handlePause);
      audio.removeEventListener('error', handleError);
    };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
    audio.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (!currentStation?.metadataUrl) {
      setMetadata(null);
      return;
    }
    let mounted = true;

    const loadMetadata = async () => {
      try {
        const response = await fetch(currentStation.metadataUrl!);
        const data = (await response.json()) as unknown;
        const parsed = extractMetadata(data, currentStation.name);
        if (mounted) {
          setMetadata(parsed);
        }
      } catch {
        if (mounted) {
          setMetadata(null);
        }
      }
    };

    loadMetadata();
    const interval = window.setInterval(loadMetadata, 20000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [currentStation?.metadataUrl, currentStation?.name]);

  const toggleFavourite = (stationId: string) => {
    setFavourites((prev) =>
      prev.includes(stationId) ? prev.filter((id) => id !== stationId) : [...prev, stationId]
    );
  };

  const toggleFallback = (stationId: string) => {
    setFallbacks((prev) =>
      prev.includes(stationId) ? prev.filter((id) => id !== stationId) : [...prev, stationId]
    );
  };

  const play = async () => {
    if (!audioRef.current) {
      return;
    }
    try {
      await audioRef.current.play();
      setError(null);
    } catch {
      setError('Playback blocked by the browser. Try pressing play again.');
    }
  };

  const pause = () => {
    audioRef.current?.pause();
  };

  const nextFallback = () => {
    if (fallbacks.length === 0) {
      return null;
    }
    const currentIndex = fallbacks.indexOf(currentId);
    if (currentIndex === -1) {
      return fallbacks[0];
    }
    return fallbacks[(currentIndex + 1) % fallbacks.length];
  };

  const triggerAutoSwitch = () => {
    const next = nextFallback();
    if (!next || next === currentId) {
      return;
    }
    console.log('[Talk Killer] Switching to fallback station:', next);
    setCurrentId(next);
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!settings.enabled || !audio || !isPlaying) {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    const setupAudioGraph = () => {
      if (!audioContextRef.current) {
        audioContextRef.current = new AudioContext();
      }
      const audioContext = audioContextRef.current;
      if (!sourceRef.current) {
        sourceRef.current = audioContext.createMediaElementSource(audio);
      }
      if (!analyserRef.current) {
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 2048;
        analyserRef.current = analyser;
        sourceRef.current.connect(analyser);
        analyser.connect(audioContext.destination);
      }
    };

    try {
      setupAudioGraph();
    } catch (err) {
      console.warn('Talk Killer disabled: unable to analyze this stream.', err);
      setAnalysisBlocked(true);
      return;
    }

    const analyser = analyserRef.current;
    const audioContext = audioContextRef.current;
    if (!analyser || !audioContext) {
      return;
    }

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const nyquist = audioContext.sampleRate / 2;
    const startIndex = Math.floor((300 / nyquist) * dataArray.length);
    const endIndex = Math.min(
      dataArray.length - 1,
      Math.floor((3000 / nyquist) * dataArray.length)
    );

    intervalRef.current = window.setInterval(() => {
      if (!analyserRef.current) {
        return;
      }
      try {
        analyserRef.current.getByteFrequencyData(dataArray);
      } catch (err) {
        console.warn('Talk Killer disabled: analyzer blocked by stream.', err);
        setAnalysisBlocked(true);
        if (intervalRef.current) {
          window.clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        return;
      }

      const total = dataArray.reduce((acc, value) => acc + value, 0);
      const mid = dataArray
        .slice(startIndex, endIndex)
        .reduce((acc, value) => acc + value, 0);
      const score = total === 0 ? 0 : mid / total;
      setSpeechScore(score);
      const isSpeech = score >= settings.sensitivity;
      setSpeechLabel(isSpeech ? 'Speech-ish' : 'Music');

      const step = 0.2;
      if (isSpeech) {
        speechSecondsRef.current += step;
      } else {
        speechSecondsRef.current = 0;
      }

      if (speechSecondsRef.current >= settings.speechSeconds) {
        const now = Date.now();
        if (now - lastSwitchRef.current >= settings.cooldownSeconds * 1000) {
          lastSwitchRef.current = now;
          speechSecondsRef.current = 0;
          triggerAutoSwitch();
        }
      }
    }, 200);

    audioContext.resume().catch(() => undefined);

    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [settings.enabled, settings.sensitivity, settings.speechSeconds, settings.cooldownSeconds, isPlaying, currentId, fallbacks]);

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Raven-Radio</h1>
          <p className="tagline">World radio with Talk Killer.</p>
        </div>
        <div className="player-status">
          <span className="label">Now tuned:</span>
          <strong>{currentStation?.name ?? 'Select a station'}</strong>
          <span className="meta">{metadata ?? 'Metadata not available'}</span>
        </div>
      </header>

      <main className="content">
        <section className="station-browser">
          <h2>Station directory</h2>
          <div className="filters">
            <input
              type="search"
              placeholder="Search by name, country, or tag"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select value={countryFilter} onChange={(event) => setCountryFilter(event.target.value)}>
              <option value="all">All countries</option>
              {countries.map((country) => (
                <option key={country} value={country}>
                  {country}
                </option>
              ))}
            </select>
            <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
              <option value="all">All tags</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </div>

          <div className="station-list">
            {filteredStations.map((station) => (
              <button
                key={station.id}
                type="button"
                className={`station-card ${station.id === currentId ? 'active' : ''}`}
                onClick={() => setCurrentId(station.id)}
              >
                <div className="station-title">
                  <span>{station.name}</span>
                  <span className="codec">{station.codec}</span>
                </div>
                <div className="station-meta">
                  <span>{station.country}</span>
                  <span>{station.tags.join(', ')}</span>
                </div>
                <div className="station-actions">
                  <span
                    className={`pill ${favourites.includes(station.id) ? 'active' : ''}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleFavourite(station.id);
                    }}
                  >
                    ★ Favourite
                  </span>
                  <span
                    className={`pill ${fallbacks.includes(station.id) ? 'active' : ''}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleFallback(station.id);
                    }}
                  >
                    ↻ Fallback
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>

        <section className="player-panel">
          <h2>Player</h2>
          <div className="controls">
            <button type="button" onClick={isPlaying ? pause : play}>
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <label className="volume">
              Volume
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(event) => setVolume(parseFloat(event.target.value))}
              />
            </label>
          </div>
          {error && <div className="error">{error}</div>}
          <audio ref={audioRef} preload="none" />

          <div className="lists">
            <div>
              <h3>Favourites</h3>
              <ul>
                {favourites.length === 0 && <li className="empty">No favourites yet.</li>}
                {favourites.map((id) => {
                  const station = stations.find((item) => item.id === id);
                  if (!station) return null;
                  return (
                    <li key={id}>
                      <button type="button" onClick={() => setCurrentId(id)}>
                        {station.name}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div>
              <h3>Fallback list</h3>
              <ul>
                {fallbacks.length === 0 && <li className="empty">No fallback stations set.</li>}
                {fallbacks.map((id) => {
                  const station = stations.find((item) => item.id === id);
                  if (!station) return null;
                  return (
                    <li key={id}>
                      <button type="button" onClick={() => setCurrentId(id)}>
                        {station.name}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>

          <div className="talk-killer">
            <div className="talk-header">
              <h3>Talk Killer</h3>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      enabled: event.target.checked
                    })
                  }
                />
                Enabled
              </label>
            </div>
            {analysisBlocked && (
              <div className="warning">
                Talk Killer disabled for this station due to stream restrictions.
              </div>
            )}
            <div className="settings-grid">
              <label>
                Speech seconds
                <input
                  type="number"
                  min={2}
                  max={20}
                  value={settings.speechSeconds}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      speechSeconds: Number(event.target.value)
                    })
                  }
                />
              </label>
              <label>
                Sensitivity (0..1)
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.sensitivity}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      sensitivity: Number(event.target.value)
                    })
                  }
                />
              </label>
              <label>
                Cooldown seconds
                <input
                  type="number"
                  min={5}
                  max={60}
                  value={settings.cooldownSeconds}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      cooldownSeconds: Number(event.target.value)
                    })
                  }
                />
              </label>
            </div>
            <div className="debug">
              <span>Speech score: {speechScore.toFixed(2)}</span>
              <span className={speechLabel === 'Speech-ish' ? 'speech' : 'music'}>
                {speechLabel}
              </span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
