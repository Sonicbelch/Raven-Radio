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
};

const stations = stationsData as Station[];

const defaultSettings: TalkKillerSettings = {
  enabled: true,
  speechSeconds: 6,
  sensitivity: 0.6,
  cooldownSeconds: 12
};

const hlsMimeType = 'application/vnd.apple.mpegurl';

const isHlsUrl = (url: string) => url.toLowerCase().includes('.m3u8');

const describeMediaError = (error: MediaError | null) => {
  if (!error) {
    return 'Unknown error';
  }
  switch (error.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return 'Playback aborted';
    case MediaError.MEDIA_ERR_NETWORK:
      return 'Network error';
    case MediaError.MEDIA_ERR_DECODE:
      return 'Decode error';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return 'Source not supported';
    default:
      return `Error code ${error.code}`;
  }
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
  const searchCacheRef = useRef<Map<string, SearchStation[]>>(new Map());
  const searchAbortRef = useRef<AbortController | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [currentId, setCurrentId] = useState(stations[0]?.id ?? '');
  const [currentStation, setCurrentStation] = useState<PlayableStation | null>(
    stations[0] ?? null
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<string | null>(null);
  const [analysisBlocked, setAnalysisBlocked] = useState(false);
  const [speechScore, setSpeechScore] = useState(0);
  const [speechLabel, setSpeechLabel] = useState('Music');
  const [autoPlayNext, setAutoPlayNext] = useState(false);

  const [favourites, setFavourites] = useLocalStorage<FavouriteStation[] | string[]>(
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
  const [searchCache, setSearchCache] = useLocalStorage<SearchCacheEntry[]>(
    'raven-radio:search-cache',
    []
  );

  const [query, setQuery] = useState('');
  const [countryFilter, setCountryFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');

  const [searchQuery, setSearchQuery] = useState('');
  const [searchCountry, setSearchCountry] = useState('');
  const [searchTag, setSearchTag] = useState('');
  const [searchResults, setSearchResults] = useState<SearchStation[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const normalizedFavourites = useMemo<FavouriteStation[]>(() => {
    if (!Array.isArray(favourites)) {
      return [];
    }
    if (favourites.length === 0) {
      return [];
    }
    if (typeof favourites[0] !== 'string') {
      return favourites as FavouriteStation[];
    }
    return (favourites as string[])
      .map((id) => {
        const station = stations.find((item) => item.id === id);
        if (!station) {
          return null;
        }
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
      .filter((item): item is FavouriteStation => Boolean(item));
  }, [favourites]);

  useEffect(() => {
    if (Array.isArray(favourites) && favourites.length > 0 && typeof favourites[0] === 'string') {
      setFavourites(normalizedFavourites);
    }
  }, [favourites, normalizedFavourites, setFavourites]);

  useEffect(() => {
    const cacheMap = new Map<string, SearchStation[]>();
    searchCache.forEach((entry) => {
      cacheMap.set(entry.key, entry.results);
    });
    searchCacheRef.current = cacheMap;
  }, [searchCache]);

  useEffect(() => {
    if (!currentId) {
      return;
    }
    const station = stations.find((item) => item.id === currentId);
    if (station) {
      setCurrentStation(station);
    }
  }, [currentId]);

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
    const url = currentStation.url;
    const hlsStream = isHlsUrl(url);
    audio.crossOrigin = 'anonymous';
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    setError(null);
    setAnalysisBlocked(false);
    setMetadata(null);
    if (hlsStream) {
      if (Hls.isSupported()) {
        const hls = new Hls();
        hlsRef.current = hls;
        hls.attachMedia(audio);
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
          hls.loadSource(url);
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            const reason = data.reason ? `: ${data.reason}` : '';
            setError(
              `Stream failed (${data.type} - ${data.details}${reason}). Try an alternate URL/server.`
            );
            setIsPlaying(false);
          }
        });
      } else if (audio.canPlayType(hlsMimeType)) {
        audio.src = url;
        audio.load();
      } else {
        setError('HLS stream not supported. Try an alternate URL/server.');
        setIsPlaying(false);
      }
    } else {
      audio.src = url;
      audio.load();
    }
    if (autoPlayNext) {
      setAutoPlayNext(false);
      play();
    }
  }, [currentStation?.url, autoPlayNext]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) {
      return;
    }
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
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
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

  const getFavouriteKey = (station: { stationuuid?: string; url?: string; id?: string }) => {
    return station.stationuuid || station.url || station.id || '';
  };

  const addFavourite = (station: FavouriteStation) => {
    setFavourites((prev) => {
      const current = Array.isArray(prev) && typeof prev[0] === 'string' ? normalizedFavourites : prev;
      const favouritesList = current as FavouriteStation[];
      if (favouritesList.some((item) => item.key === station.key)) {
        return favouritesList;
      }
      return [station, ...favouritesList];
    });
  };

  const removeFavourite = (key: string) => {
    setFavourites((prev) => {
      const current = Array.isArray(prev) && typeof prev[0] === 'string' ? normalizedFavourites : prev;
      const favouritesList = current as FavouriteStation[];
      return favouritesList.filter((item) => item.key !== key);
    });
  };

  const toggleFavourite = (station: Station) => {
    const key = station.id;
    if (normalizedFavourites.some((item) => item.key === key)) {
      removeFavourite(key);
      return;
    }
    addFavourite({
      key,
      name: station.name,
      country: station.country,
      tags: station.tags,
      url: station.url,
      codec: station.codec,
      stationuuid: station.id,
      source: 'local',
      localId: station.id
    });
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

  const updateSearchCache = useCallback(
    (key: string, results: SearchStation[]) => {
      searchCacheRef.current.set(key, results);
      setSearchCache((prev) => {
        const filtered = prev.filter((entry) => entry.key !== key);
        const next = [{ key, results, cachedAt: Date.now() }, ...filtered];
        return next.slice(0, 20);
      });
    },
    [setSearchCache]
  );

  const performSearch = useCallback(async (name: string, country: string, tag: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    const key = [trimmed.toLowerCase(), country.trim().toLowerCase(), tag.trim().toLowerCase()]
      .filter(Boolean)
      .join('|');
    const cached = searchCacheRef.current.get(key);
    if (cached) {
      setSearchResults(cached);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }

    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearchLoading(true);
    setSearchError(null);

    try {
      const params = new URLSearchParams({
        name: trimmed,
        limit: '20'
      });
      if (country.trim()) {
        params.set('country', country.trim());
      }
      if (tag.trim()) {
        params.set('tag', tag.trim());
      }
      const response = await fetch(
        `https://de1.api.radio-browser.info/json/stations/search?${params.toString()}`,
        { signal: controller.signal }
      );
      if (!response.ok) {
        throw new Error('Search failed');
      }
      const data = (await response.json()) as unknown;
      const results = Array.isArray(data)
        ? data
            .map((item) => {
              const record = item as Record<string, unknown>;
              const nameValue = typeof record.name === 'string' ? record.name.trim() : '';
              const urlValue =
                typeof record.url_resolved === 'string'
                  ? record.url_resolved
                  : typeof record.url === 'string'
                    ? record.url
                    : '';
              if (!nameValue || !urlValue) {
                return null;
              }
              const tagsValue =
                typeof record.tags === 'string'
                  ? record.tags
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean)
                  : [];
              return {
                stationuuid:
                  typeof record.stationuuid === 'string' ? record.stationuuid : undefined,
                name: nameValue,
                country: typeof record.country === 'string' ? record.country : 'Unknown',
                tags: tagsValue,
                url: urlValue,
                codec: typeof record.codec === 'string' ? record.codec : undefined,
                bitrate: typeof record.bitrate === 'number' ? record.bitrate : undefined
              } satisfies SearchStation;
            })
            .filter((item): item is SearchStation => Boolean(item))
        : [];
      setSearchResults(results);
      updateSearchCache(key, results);
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      console.error('Radio Browser search failed', err);
      setSearchResults([]);
      setSearchError(
        'We could not reach the Radio Browser service. Please check your connection and try again.'
      );
    } finally {
      if (!controller.signal.aborted) {
        setSearchLoading(false);
      }
    }
  }, [updateSearchCache]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      performSearch(searchQuery, searchCountry, searchTag);
    }, 400);
    return () => {
      window.clearTimeout(timeout);
    };
  }, [performSearch, searchQuery, searchCountry, searchTag]);

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

  const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    performSearch(searchQuery, searchCountry, searchTag);
  };

  const playSearchStation = (station: SearchStation) => {
    const playable: PlayableStation = {
      name: station.name,
      country: station.country,
      tags: station.tags,
      url: station.url,
      codec: station.codec,
      bitrate: station.bitrate
    };
    setCurrentId('');
    setCurrentStation(playable);
    setAutoPlayNext(true);
  };

  const addSearchFavourite = (station: SearchStation) => {
    const key = getFavouriteKey(station);
    if (!key) {
      return;
    }
    addFavourite({
      key,
      name: station.name,
      country: station.country,
      tags: station.tags,
      url: station.url,
      codec: station.codec,
      bitrate: station.bitrate,
      stationuuid: station.stationuuid,
      source: 'search'
    });
  };

  const playFavourite = (station: FavouriteStation) => {
    if (station.localId) {
      setCurrentId(station.localId);
      return;
    }
    const playable: PlayableStation = {
      name: station.name,
      country: station.country,
      tags: station.tags,
      url: station.url,
      codec: station.codec,
      bitrate: station.bitrate
    };
    setCurrentId('');
    setCurrentStation(playable);
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
              const isFavourite = normalizedFavourites.some(
                (item) => item.key === getFavouriteKey(station)
              );
              return (
                <div key={getFavouriteKey(station)} className="search-card">
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
                        .filter(Boolean)
                        .join(' • ') || 'Codec/bitrate N/A'}
                    </span>
                  </div>
                  <div className="search-actions">
                    <button type="button" onClick={() => playSearchStation(station)}>
                      Play
                    </button>
                    <button
                      type="button"
                      className={isFavourite ? 'secondary' : ''}
                      onClick={() => addSearchFavourite(station)}
                      disabled={isFavourite}
                    >
                      {isFavourite ? 'In favourites' : 'Add to favourites'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

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
                    className={`pill ${
                      normalizedFavourites.some((item) => item.key === station.id) ? 'active' : ''
                    }`}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleFavourite(station);
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
                {normalizedFavourites.length === 0 && (
                  <li className="empty">No favourites yet.</li>
                )}
                {normalizedFavourites.map((station) => (
                  <li key={station.key} className="favourite-item">
                    <button type="button" onClick={() => playFavourite(station)}>
                      {station.name}
                      {station.country && (
                        <span className="subtle">
                          {station.country}
                          {station.tags && station.tags.length > 0
                            ? ` • ${station.tags.join(', ')}`
                            : ''}
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => removeFavourite(station.key)}
                    >
                      Remove
                    </button>
                  </li>
                ))}
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
