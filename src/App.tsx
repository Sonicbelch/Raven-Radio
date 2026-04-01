import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Hls from 'hls.js';
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

type SearchStation = {
  stationuuid?: string;
  name: string;
  country: string;
  tags: string[];
  url: string;
  codec?: string;
  bitrate?: number;
};

type PlayableStation = {
  id?: string;
  name: string;
  country?: string;
  tags?: string[];
  url: string;
  codec?: string;
  bitrate?: number;
  metadataUrl?: string;
};

type FavouriteStation = {
  key: string;
  name: string;
  country?: string;
  tags?: string[];
  url: string;
  codec?: string;
  bitrate?: number;
  stationuuid?: string;
  source: 'local' | 'search';
  localId?: string;
};

type PresetSlot = FavouriteStation | null;

type SearchCacheEntry = {
  key: string;
  results: SearchStation[];
  cachedAt: number;
};

type TalkKillerSettings = {
  enabled: boolean;
  speechSeconds: number;
  sensitivity: number;
  cooldownSeconds: number;
  hfPenaltyStrength: number;
};

const stations = stationsData as Station[];

const PRESET_COUNT = 9;

const defaultPresets: PresetSlot[] = (() => {
  const slots: PresetSlot[] = Array(PRESET_COUNT).fill(null);
  (stationsData as Station[]).slice(0, PRESET_COUNT).forEach((s, i) => {
    slots[i] = {
      key: s.id,
      name: s.name,
      country: s.country,
      tags: s.tags,
      url: s.url,
      codec: s.codec,
      source: 'local',
      localId: s.id
    };
  });
  return slots;
})();

const defaultSettings: TalkKillerSettings = {
  enabled: true,
  speechSeconds: 6,
  sensitivity: 0.3,
  cooldownSeconds: 12,
  hfPenaltyStrength: 1.5
};

const hlsMimeType = 'application/vnd.apple.mpegurl';

const isHlsUrl = (url: string) => url.toLowerCase().includes('.m3u8');

const describeMediaError = (error: MediaError | null) => {
  if (!error) return 'Unknown error';
  switch (error.code) {
    case MediaError.MEDIA_ERR_ABORTED: return 'Playback aborted';
    case MediaError.MEDIA_ERR_NETWORK: return 'Network error';
    case MediaError.MEDIA_ERR_DECODE: return 'Decode error';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: return 'Source not supported';
    default: return `Error code ${error.code}`;
  }
};

function useLocalStorage<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key);
    if (!stored) return initialValue;
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
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.channels) && record.channels.length > 0) {
    const channel = record.channels[0] as Record<string, unknown>;
    if (typeof channel.lastPlaying === 'string') return channel.lastPlaying;
    if (typeof channel.title === 'string') return channel.title;
  }
  if (typeof record.now_playing === 'string') return record.now_playing;
  if (typeof record.title === 'string') return record.title;
  return `Streaming ${stationName}`;
}

const buildStationMetadata = (station: PlayableStation | null) => {
  if (!station) return null;
  const parts: string[] = [];
  if (station.tags && station.tags.length > 0) parts.push(station.tags.slice(0, 4).join(', '));
  const codecParts = [station.codec, station.bitrate ? `${station.bitrate} kbps` : null]
    .filter(Boolean).join(' ');
  if (codecParts) parts.push(codecParts);
  return parts.length > 0 ? parts.join(' • ') : null;
};

const isBlockedMetadataUrl = (url: string) => {
  try {
    const { hostname } = new URL(url);
    return hostname.endsWith('somafm.com');
  } catch {
    return true;
  }
};

const shouldUseMetadataProxy = () => {
  return import.meta.env.DEV || import.meta.env.VITE_METADATA_PROXY === 'true';
};

const buildMetadataRequestUrl = (metadataUrl: string) => {
  if (!shouldUseMetadataProxy()) return metadataUrl;
  const proxyBase = import.meta.env.VITE_METADATA_PROXY_URL || '/api/metadata';
  const proxyUrl = new URL(proxyBase, window.location.origin);
  proxyUrl.searchParams.set('url', metadataUrl);
  return proxyUrl.toString();
};

function App() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const intervalRef = useRef<number | null>(null);
  const lastSwitchRef = useRef<number>(0);
  const speechSecondsRef = useRef<number>(0);
  const searchCacheRef = useRef<Map<string, SearchStation[]>>(new Map());
  const searchAbortRef = useRef<AbortController | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [currentId, setCurrentId] = useState(stations[0]?.id ?? '');
  const [currentStation, setCurrentStation] = useState<PlayableStation | null>(stations[0] ?? null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<string | null>(null);
  const [analysisBlocked, setAnalysisBlocked] = useState(false);
  const [speechScore, setSpeechScore] = useState(0);
  const [speechLabel, setSpeechLabel] = useState('Music');
  const [autoPlayNext, setAutoPlayNext] = useState(false);
  const [masalaIndex, setMasalaIndex] = useState(0);

  const [favourites, setFavourites] = useLocalStorage<FavouriteStation[] | string[]>('raven-radio:favourites', []);
  const [fallbacks, setFallbacks] = useLocalStorage<FavouriteStation[]>('raven-radio:fallbacks', []);
  const [settings, setSettings] = useLocalStorage<TalkKillerSettings>('raven-radio:settings', defaultSettings);
  const [searchCache, setSearchCache] = useLocalStorage<SearchCacheEntry[]>('raven-radio:search-cache', []);
  const [presets, setPresets] = useLocalStorage<PresetSlot[]>('raven-radio:presets', defaultPresets);
  const [masalaEnabled, setMasalaEnabled] = useLocalStorage<boolean>('raven-radio:masala', false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchCountry, setSearchCountry] = useState('');
  const [searchTag, setSearchTag] = useState('');
  const [searchResults, setSearchResults] = useState<SearchStation[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const normalizedFavourites = useMemo<FavouriteStation[]>(() => {
    if (!Array.isArray(favourites)) return [];
    if (favourites.length === 0) return [];
    if (typeof favourites[0] !== 'string') return favourites as FavouriteStation[];
    return (favourites as string[])
      .map((id): FavouriteStation | null => {
        const station = stations.find((item) => item.id === id);
        if (!station) return null;
        return {
          key: station.id,
          name: station.name,
          country: station.country,
          tags: station.tags,
          url: station.url,
          codec: station.codec,
          source: 'local' as const,
          localId: station.id
        };
      })
      .filter((item): item is FavouriteStation => item !== null);
  }, [favourites]);

  useEffect(() => {
    if (Array.isArray(favourites) && favourites.length > 0 && typeof favourites[0] === 'string') {
      setFavourites(normalizedFavourites);
    }
  }, [favourites, normalizedFavourites, setFavourites]);

  useEffect(() => {
    const cacheMap = new Map<string, SearchStation[]>();
    searchCache.forEach((entry) => { cacheMap.set(entry.key, entry.results); });
    searchCacheRef.current = cacheMap;
  }, [searchCache]);

  useEffect(() => {
    if (!currentId) return;
    const station = stations.find((item) => item.id === currentId);
    if (station) setCurrentStation(station);
  }, [currentId]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentStation) return;
    const url = currentStation.url;
    const hlsStream = isHlsUrl(url);
    audio.crossOrigin = 'anonymous';
    if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
    setError(null);
    setAnalysisBlocked(false);
    setMetadata(null);
    if (hlsStream) {
      if (Hls.isSupported()) {
        const hls = new Hls();
        hlsRef.current = hls;
        hls.attachMedia(audio);
        hls.on(Hls.Events.MEDIA_ATTACHED, () => { hls.loadSource(url); });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            const reason = data.reason ? `: ${data.reason}` : '';
            setError(`Stream failed (${data.type} - ${data.details}${reason}). Try an alternate URL/server.`);
            setIsPlaying(false);
          }
        });
      } else if (audio.canPlayType(hlsMimeType)) {
        audio.src = url; audio.load();
      } else {
        setError('HLS stream not supported. Try an alternate URL/server.');
        setIsPlaying(false);
      }
    } else {
      audio.src = url; audio.load();
    }
    if (autoPlayNext) {
      setAutoPlayNext(false);
      const playWhenReady = () => {
        audio.removeEventListener('canplay', playWhenReady);
        audio.play().catch(() => { setError('Playback blocked by the browser. Try pressing play again.'); });
      };
      audio.addEventListener('canplay', playWhenReady);
    }
  }, [currentStation?.url, autoPlayNext]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleError = () => {
      const detail = describeMediaError(audio.error);
      setError(`Stream failed (${detail}). Try an alternate URL/server.`);
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
    return () => { if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; } };
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
  }, [volume]);

  useEffect(() => {
    const fallback = buildStationMetadata(currentStation);
    const metadataUrl = currentStation?.metadataUrl;
    if (!metadataUrl || isBlockedMetadataUrl(metadataUrl)) { setMetadata(fallback); return; }
    let mounted = true;
    const loadMetadata = async () => {
      try {
        const response = await fetch(buildMetadataRequestUrl(metadataUrl), { headers: { Accept: 'application/json' } });
        const data = (await response.json()) as unknown;
        const parsed = extractMetadata(data, currentStation.name);
        if (mounted) setMetadata(parsed ?? fallback);
      } catch {
        if (mounted) setMetadata(fallback);
      }
    };
    setMetadata(fallback);
    loadMetadata();
    const interval = window.setInterval(loadMetadata, 20000);
    return () => { mounted = false; window.clearInterval(interval); };
  }, [currentStation?.metadataUrl, currentStation?.name, currentStation?.tags, currentStation?.codec, currentStation?.bitrate]);

  const getFavouriteKey = (station: { stationuuid?: string; url?: string; id?: string }) => {
    return station.stationuuid || station.url || station.id || '';
  };

  const addFavourite = (station: FavouriteStation) => {
    setFavourites((prev) => {
      const current = Array.isArray(prev) && typeof prev[0] === 'string' ? normalizedFavourites : prev;
      const list = current as FavouriteStation[];
      if (list.some((item) => item.key === station.key)) return list;
      return [station, ...list];
    });
  };



  const addFallback = (station: FavouriteStation) => {
    setFallbacks((prev) => {
      if (prev.some((item) => item.key === station.key)) return prev;
      return [...prev, station];
    });
  };

  const removeFallback = (key: string) => {
    setFallbacks((prev) => prev.filter((item) => item.key !== key));
  };

  const setPresetSlot = (index: number, station: FavouriteStation | null) => {
    setPresets((prev) => {
      const next = [...(prev.length === PRESET_COUNT ? prev : defaultPresets)];
      next[index] = station;
      return next;
    });
  };

  const playPreset = (station: FavouriteStation) => {
    if (station.localId) {
      setCurrentId(station.localId);
      setAutoPlayNext(true);
      return;
    }
    const playable: PlayableStation = {
      name: station.name, country: station.country, tags: station.tags,
      url: station.url, codec: station.codec, bitrate: station.bitrate
    };
    setCurrentId('');
    setCurrentStation(playable);
    setAutoPlayNext(true);
  };

  const searchStationToPreset = (station: SearchStation): FavouriteStation => ({
    key: getFavouriteKey(station),
    name: station.name, country: station.country, tags: station.tags,
    url: station.url, codec: station.codec, bitrate: station.bitrate,
    stationuuid: station.stationuuid, source: 'search'
  });

  const searchStationToFallback = (station: SearchStation): FavouriteStation => ({
    key: getFavouriteKey(station),
    name: station.name, country: station.country, tags: station.tags,
    url: station.url, codec: station.codec, bitrate: station.bitrate,
    stationuuid: station.stationuuid, source: 'search'
  });

  const play = async () => {
    if (!audioRef.current) return;
    try {
      await audioRef.current.play();
      setError(null);
    } catch {
      setError('Playback blocked by the browser. Try pressing play again.');
    }
  };

  const pause = () => { audioRef.current?.pause(); };

  const filledPresets = useMemo(() => presets.filter((s): s is FavouriteStation => s !== null), [presets]);

  const nextFallbackStation = (): FavouriteStation | null => {
    if (fallbacks.length === 0) return null;
    const currentKey = currentId || currentStation?.url || '';
    const idx = fallbacks.findIndex((s) => s.key === currentKey || s.url === currentStation?.url);
    if (idx === -1) return fallbacks[0];
    return fallbacks[(idx + 1) % fallbacks.length];
  };

  const triggerAutoSwitch = () => {
    if (masalaEnabled) {
      if (filledPresets.length === 0) return;
      const nextIdx = masalaIndex % filledPresets.length;
      const next = filledPresets[nextIdx];
      setMasalaIndex((nextIdx + 1) % filledPresets.length);
      console.log('[Station Masala] Switching to preset:', next.name);
      playPreset(next);
    } else {
      const next = nextFallbackStation();
      if (!next) return;
      console.log('[Talk Killer] Switching to fallback:', next.name);
      playPreset(next);
    }
  };

  const handleRandomise = () => {
    if (filledPresets.length === 0) return;
    const pick = filledPresets[Math.floor(Math.random() * filledPresets.length)];
    playPreset(pick);
  };

  const updateSearchCache = useCallback((key: string, results: SearchStation[]) => {
    searchCacheRef.current.set(key, results);
    setSearchCache((prev) => {
      const filtered = prev.filter((entry) => entry.key !== key);
      const next = [{ key, results, cachedAt: Date.now() }, ...filtered];
      return next.slice(0, 20);
    });
  }, [setSearchCache]);

  const performSearch = useCallback(async (name: string, country: string, tag: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setSearchResults([]); setSearchError(null); setSearchLoading(false); return;
    }
    const key = [trimmed.toLowerCase(), country.trim().toLowerCase(), tag.trim().toLowerCase()]
      .filter(Boolean).join('|');
    const cached = searchCacheRef.current.get(key);
    if (cached) {
      setSearchResults(cached); setSearchError(null); setSearchLoading(false); return;
    }
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchLoading(true); setSearchError(null);
    try {
      const params = new URLSearchParams({ name: trimmed, limit: '20' });
      if (country.trim()) params.set('country', country.trim());
      if (tag.trim()) params.set('tag', tag.trim());
      const response = await fetch(
        `https://de1.api.radio-browser.info/json/stations/search?${params.toString()}`,
        { signal: controller.signal }
      );
      if (!response.ok) throw new Error('Search failed');
      const data = (await response.json()) as unknown;
      const results = Array.isArray(data)
        ? data.map((item): SearchStation | null => {
            const record = item as Record<string, unknown>;
            const nameValue = typeof record.name === 'string' ? record.name.trim() : '';
            const urlValue = typeof record.url_resolved === 'string' ? record.url_resolved
              : typeof record.url === 'string' ? record.url : '';
            if (!nameValue || !urlValue) return null;
            const tagsValue = typeof record.tags === 'string'
              ? record.tags.split(',').map((v) => v.trim()).filter(Boolean) : [];
            return {
              stationuuid: typeof record.stationuuid === 'string' ? record.stationuuid : undefined,
              name: nameValue,
              country: typeof record.country === 'string' ? record.country : 'Unknown',
              tags: tagsValue,
              url: urlValue,
              codec: typeof record.codec === 'string' ? record.codec : undefined,
              bitrate: typeof record.bitrate === 'number' ? record.bitrate : undefined
            } satisfies SearchStation;
          }).filter((item): item is SearchStation => item !== null)
        : [];
      setSearchResults(results);
      updateSearchCache(key, results);
    } catch (err) {
      if (controller.signal.aborted) return;
      console.error('Radio Browser search failed', err);
      setSearchResults([]);
      setSearchError('We could not reach the Radio Browser service. Please check your connection and try again.');
    } finally {
      if (!controller.signal.aborted) setSearchLoading(false);
    }
  }, [updateSearchCache]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { performSearch(searchQuery, searchCountry, searchTag); }, 400);
    return () => { window.clearTimeout(timeout); };
  }, [performSearch, searchQuery, searchCountry, searchTag]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!settings.enabled || !audio || !isPlaying) {
      if (intervalRef.current) { window.clearInterval(intervalRef.current); intervalRef.current = null; }
      return;
    }
    const setupAudioGraph = () => {
      if (!audioContextRef.current) audioContextRef.current = new AudioContext();
      const audioContext = audioContextRef.current;
      if (!sourceRef.current) sourceRef.current = audioContext.createMediaElementSource(audio);
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
    if (!analyser || !audioContext) return;
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    const nyquist = audioContext.sampleRate / 2;
    const binCount = dataArray.length;
    // Speech band: 300–3400 Hz
    const speechStart = Math.floor((300 / nyquist) * binCount);
    const speechEnd = Math.min(binCount - 1, Math.floor((3400 / nyquist) * binCount));
    // High-frequency band: 4000–10000 Hz (music has lots here, speech has very little)
    const hfStart = Math.floor((4000 / nyquist) * binCount);
    const hfEnd = Math.min(binCount - 1, Math.floor((10000 / nyquist) * binCount));
    intervalRef.current = window.setInterval(() => {
      if (!analyserRef.current) return;
      try {
        analyserRef.current.getByteFrequencyData(dataArray);
      } catch (err) {
        console.warn('Talk Killer disabled: analyzer blocked by stream.', err);
        setAnalysisBlocked(true);
        if (intervalRef.current) { window.clearInterval(intervalRef.current); intervalRef.current = null; }
        return;
      }
      const total = dataArray.reduce((acc, value) => acc + value, 0);
      if (total === 0) { setSpeechScore(0); setSpeechLabel('Music'); return; }
      const speechBand = dataArray.slice(speechStart, speechEnd).reduce((acc, v) => acc + v, 0);
      const hfBand = dataArray.slice(hfStart, hfEnd).reduce((acc, v) => acc + v, 0);
      // Mid-band ratio: how much energy is in the speech band
      const midRatio = speechBand / total;
      // HF penalty: music has lots of high-freq energy relative to speech band; speech doesn't
      const hfRatio = speechBand > 0 ? hfBand / speechBand : 0;
      const hfPenalty = Math.min(hfRatio * settings.hfPenaltyStrength, 1);
      // Final score: high if speech-band dominant AND low high-freq energy
      const score = midRatio * (1 - hfPenalty);
      setSpeechScore(score);
      const isSpeech = score >= settings.sensitivity;
      setSpeechLabel(isSpeech ? 'Speech-ish' : 'Music');
      const step = 0.2;
      if (isSpeech) { speechSecondsRef.current += step; } else { speechSecondsRef.current = 0; }
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
    return () => { if (intervalRef.current) { window.clearInterval(intervalRef.current); intervalRef.current = null; } };
  }, [settings.enabled, settings.sensitivity, settings.speechSeconds, settings.cooldownSeconds, isPlaying, currentId, fallbacks, masalaEnabled, masalaIndex, filledPresets]);

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    performSearch(searchQuery, searchCountry, searchTag);
  };

  const playSearchStation = (station: SearchStation) => {
    const playable: PlayableStation = {
      name: station.name, country: station.country, tags: station.tags,
      url: station.url, codec: station.codec, bitrate: station.bitrate
    };
    setCurrentId('');
    setCurrentStation(playable);
    setAutoPlayNext(true);
  };

  const addSearchFavourite = (station: SearchStation) => {
    const key = getFavouriteKey(station);
    if (!key) return;
    addFavourite({
      key, name: station.name, country: station.country, tags: station.tags,
      url: station.url, codec: station.codec, bitrate: station.bitrate,
      stationuuid: station.stationuuid, source: 'search'
    });
  };

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
          <h2>Search stations</h2>
          <form className="search-form" onSubmit={handleSearchSubmit}>
            <div className="search-fields">
              <input
                type="search"
                placeholder="Search stations by name"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              <input
                type="text"
                placeholder="Country (optional)"
                value={searchCountry}
                onChange={(event) => setSearchCountry(event.target.value)}
              />
              <input
                type="text"
                placeholder="Tag (optional)"
                value={searchTag}
                onChange={(event) => setSearchTag(event.target.value)}
              />
              <button type="submit" disabled={searchLoading}>
                {searchLoading ? 'Searching...' : 'Search'}
              </button>
            </div>
            <p className="hint">Type a name and press Enter, or wait a moment for auto-search.</p>
          </form>
          {searchError && <div className="error">{searchError}</div>}
          {!searchError && searchQuery.trim() && !searchLoading && searchResults.length === 0 && (
            <div className="empty">No stations found yet. Try adjusting your search.</div>
          )}
          {searchLoading && <div className="loading">Loading stations...</div>}
          <div className="search-results">
            {searchResults.map((station) => {
              const key = getFavouriteKey(station);
              const isFavourite = normalizedFavourites.some((item) => item.key === key);
              const inFallbacks = fallbacks.some((item) => item.key === key);
              return (
                <div key={key} className="search-card">
                  <div className="search-card__header">
                    <div>
                      <strong>{station.name}</strong>
                      <div className="search-meta">
                        <span>{station.country}</span>
                        <span>{station.tags.length ? station.tags.join(', ') : 'No tags'}</span>
                      </div>
                    </div>
                    <span className="codec">
                      {[station.codec, station.bitrate ? `${station.bitrate} kbps` : null]
                        .filter(Boolean).join(' • ') || 'Codec/bitrate N/A'}
                    </span>
                  </div>
                  <div className="search-actions">
                    <button type="button" onClick={() => playSearchStation(station)}>Play</button>
                    <button
                      type="button"
                      className={isFavourite ? 'secondary' : ''}
                      onClick={() => addSearchFavourite(station)}
                      disabled={isFavourite}
                    >
                      {isFavourite ? 'In favourites' : 'Add to favourites'}
                    </button>
                    <button
                      type="button"
                      className={inFallbacks ? 'secondary' : ''}
                      onClick={() => addFallback(searchStationToFallback(station))}
                      disabled={inFallbacks}
                    >
                      {inFallbacks ? 'In fallbacks' : 'Add to fallbacks'}
                    </button>
                    <select
                      value=""
                      onChange={(e) => {
                        const idx = parseInt(e.target.value, 10);
                        if (!isNaN(idx)) setPresetSlot(idx, searchStationToPreset(station));
                      }}
                    >
                      <option value="">Set as preset…</option>
                      {Array.from({ length: PRESET_COUNT }, (_, i) => (
                        <option key={i} value={i}>
                          {`Slot ${i + 1}${presets[i] ? ` (${presets[i]!.name})` : ' (empty)'}`}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
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
                type="range" min={0} max={1} step={0.01} value={volume}
                onChange={(event) => setVolume(parseFloat(event.target.value))}
              />
            </label>
          </div>
          {error && <div className="error">{error}</div>}
          <audio ref={audioRef} preload="none" />

          <div>
            <h3>Presets</h3>
            <div className="presets-grid">
              {Array.from({ length: PRESET_COUNT }, (_, i) => {
                const slot = presets[i] ?? null;
                const isActive = slot && (
                  (slot.localId && slot.localId === currentId) ||
                  (!slot.localId && currentStation?.url === slot.url)
                );
                return (
                  <div key={i} className={`preset-slot${slot ? '' : ' empty'}${isActive ? ' active' : ''}`}>
                    <span className="preset-number">{i + 1}</span>
                    {slot ? (
                      <>
                        <button type="button" className="preset-name" onClick={() => playPreset(slot)} title={slot.name}>
                          {slot.name}
                        </button>
                        <button type="button" className="preset-clear" onClick={() => setPresetSlot(i, null)} title="Clear slot">✕</button>
                      </>
                    ) : (
                      <span className="preset-empty">empty</span>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="hint" style={{ marginTop: '0.5rem' }}>Use "Set as preset…" on any station to assign a slot.</p>
          </div>

          <div className="masala">
            <div className="masala-header">
              <h3>🌶️ Station Masala</h3>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={masalaEnabled}
                  onChange={(e) => setMasalaEnabled(e.target.checked)}
                />
                Enabled
              </label>
            </div>
            <p>Rotates through your presets when speech is detected.</p>
            <div className="masala-actions">
              <button className="randomise-btn" type="button" onClick={handleRandomise} disabled={filledPresets.length === 0}>
                🎲 Randomise
              </button>
            </div>
          </div>

          <div className="fallback-list">
            <h3>Fallback list</h3>
            {fallbacks.length === 0 && (
              <p className="empty">No fallback stations set. Add from search results.</p>
            )}
            {fallbacks.map((station) => (
              <div key={station.key} className="fallback-item">
                <button className="fallback-play" type="button" onClick={() => playPreset(station)}>
                  {station.name}
                </button>
                <button className="fallback-remove" type="button" onClick={() => removeFallback(station.key)}>✕</button>
              </div>
            ))}
          </div>

          <div className="talk-killer">
            <div className="talk-header">
              <h3>Talk Killer</h3>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
                />
                Enabled
              </label>
            </div>
            {analysisBlocked && (
              <div className="warning">Talk Killer disabled for this station due to stream restrictions.</div>
            )}
            <div className="settings-grid">
              <label>
                <span className="slider-label">Sensitivity <em>{settings.sensitivity.toFixed(2)}</em></span>
                <input type="range" min={0.05} max={0.8} step={0.01} value={settings.sensitivity}
                  onChange={(e) => setSettings({ ...settings, sensitivity: Number(e.target.value) })} />
                <span className="slider-hint">Lower = triggers more easily</span>
              </label>
              <label>
                <span className="slider-label">Speech duration <em>{settings.speechSeconds}s</em></span>
                <input type="range" min={2} max={20} step={1} value={settings.speechSeconds}
                  onChange={(e) => setSettings({ ...settings, speechSeconds: Number(e.target.value) })} />
                <span className="slider-hint">Seconds of speech before switching</span>
              </label>
              <label>
                <span className="slider-label">Music filter <em>{settings.hfPenaltyStrength.toFixed(1)}×</em></span>
                <input type="range" min={0} max={3} step={0.1} value={settings.hfPenaltyStrength}
                  onChange={(e) => setSettings({ ...settings, hfPenaltyStrength: Number(e.target.value) })} />
                <span className="slider-hint">Higher = less likely to mistake music for speech</span>
              </label>
              <label>
                <span className="slider-label">Cooldown <em>{settings.cooldownSeconds}s</em></span>
                <input type="range" min={5} max={60} step={1} value={settings.cooldownSeconds}
                  onChange={(e) => setSettings({ ...settings, cooldownSeconds: Number(e.target.value) })} />
                <span className="slider-hint">Minimum gap between switches</span>
              </label>
            </div>
            <div className="debug">
              <span>Speech score: {speechScore.toFixed(2)}</span>
              <span className={speechLabel === 'Speech-ish' ? 'speech' : 'music'}>{speechLabel}</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
