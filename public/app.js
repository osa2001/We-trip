// ============ API HELPERS ============

let googleMap = null;
let mapMarkers = [];
let mapPolylines = [];
const travelMatrixCache = new Map();
let supabaseBrowserClient = null;
let activeInviteTrip = null;
let activeMembersChannel = null;
window._activeTripId = window._activeTripId || null;
let sharedTripId = null;
let currentSharedMemberName = null;
let isSharedPlanner = false;
let memberSaveTimer = null;
const placeDetailsCache = new Map();
const localWishlist = new Set();
let cityAutocomplete = null;
let countryAutocomplete = null;
let departureAirportAutocomplete = null;
let arrivalAirportAutocomplete = null;
const hotelAreaAutocompletes = new Map();
const wishlistState = {
  counts: new Map(),
  mine: new Set()
};
let guideState = null;

// vibe 类型映射到 Google Places includedTypes
const vibeToPlaceTypes = {
  "slow-cafe": "cafe,coffee_shop",
  "architecture": "tourist_attraction,art_gallery",
  "night": "bar,night_club",
  "nature": "park",
  "museum": "museum,art_gallery",
  "local-food": "restaurant,food_market",
  "retro": "clothing_store,book_store",
  "luxury": "spa,restaurant",
  "family": "amusement_park,zoo,aquarium",
  "shopping": "shopping_mall,department_store",
  "history": "historical_landmark,museum",
  "hidden": "tourist_attraction,park"
};

function getMinRatingCount(destination) {
  const highTraffic = [
    "Tokyo", "Paris", "London", "Rome",
    "Barcelona", "New York City", "Los Angeles",
    "Amsterdam", "Prague", "Lisbon"
  ];
  const mediumTraffic = [
    "Berlin", "Madrid", "Florence", "Milan",
    "San Francisco", "Chicago", "Vienna",
    "Budapest", "Krakow", "Seville"
  ];
  if (highTraffic.includes(destination)) return 200;
  if (mediumTraffic.includes(destination)) return 100;
  return 50;
}

// 把 Google priceLevel 转换成 USD 估算费用
const priceLevelToUSD = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 12,
  PRICE_LEVEL_MODERATE: 35,
  PRICE_LEVEL_EXPENSIVE: 90,
  PRICE_LEVEL_VERY_EXPENSIVE: 180
};

// 把 Google Places 结果转换成 app.js 的 place 格式
function normalizePlaceFromAPI(apiPlace, vibe, cityCenter) {
  const cost = priceLevelToUSD[apiPlace.priceLevel] ?? 25;
  // 把真实 GPS 坐标转换成 0-100 的相对坐标
  // 以城市中心为基准，±0.1 度范围映射到 0-100
  const xRange = 0.15;
  const yRange = 0.15;
  const x = clamp(
    Math.round(50 + (apiPlace.location.longitude - cityCenter.lng) / xRange * 50),
    5, 95
  );
  const y = clamp(
    Math.round(50 - (apiPlace.location.latitude - cityCenter.lat) / yRange * 50),
    5, 95
  );
  const photoName = apiPlace.photos?.[0]?.name || null;
  const imageUrl = photoName
    ? `/api/photo?name=${encodeURIComponent(photoName)}`
    : "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=82";
  const editorialSummary = apiPlace.editorialSummary?.text || "";
  return [
    apiPlace.displayName?.text || apiPlace.name,
    vibe,
    x,
    y,
    cost,
    "待计算",
    apiPlace.formattedAddress || "",
    imageUrl,
    apiPlace.location.latitude,
    apiPlace.location.longitude,
    "",
    editorialSummary,
    apiPlace.id || "",
    apiPlace.userRatingCount || 0
  ];
}

// 获取城市中心坐标（调用 /api/geocode）
async function getCityCenter(city, country) {

  try {
    const query = encodeURIComponent(`${city}, ${country}`);
    const res = await fetch(`/api/geocode?address=${query}`);
    const data = await res.json();
    if (data.lat) return { lat: data.lat, lng: data.lng };
  } catch {}
  return null;
}

// 获取系统推荐地点（调用 /api/places）
async function fetchSystemPlaces(cityCenter, vibes, city = "") {
  if (!cityCenter) return [];

  try {
    const vibeTypes = [...new Set(
      vibes.flatMap((v) => (vibeToPlaceTypes[v] || "tourist_attraction").split(","))
    )].slice(0, 5).join(",");
    const landmarkTypes = [
      "tourist_attraction",
      "museum",
      "historical_landmark",
      "cultural_landmark",
      "art_gallery"
    ].join(",");

    const fetchRecommendationsByTypes = async (includedTypes) => {
      const res = await fetch(
        `/api/places?type=recommendations` +
        `&lat=${cityCenter.lat}&lng=${cityCenter.lng}` +
        `&includedTypes=${encodeURIComponent(includedTypes)}` +
        `&destination=${encodeURIComponent(city || state.latestTrip?.destination || "")}`
      );
      const data = await res.json();
      return data.places || [];
    };

    const [vibePlaces, landmarkPlaces] = await Promise.all([
      fetchRecommendationsByTypes(vibeTypes),
      fetchRecommendationsByTypes(landmarkTypes)
    ]);

    const placesById = new Map();
    [...vibePlaces, ...landmarkPlaces].forEach((place) => {
      const id = place.id || place.name || place.displayName?.text;
      if (!id || placesById.has(id)) return;
      placesById.set(id, place);
    });

    // 过滤质量
    return [...placesById.values()]
      .filter((p) => {
        const minCount = getMinRatingCount(city || state.latestTrip?.destination || "");
        return p.rating >= 4.0 && p.userRatingCount >= minCount;
      })
      .sort((a, b) =>
        (b.rating || 0) - (a.rating || 0) ||
        (b.userRatingCount || 0) - (a.userRatingCount || 0)
      )
      .slice(0, 20)
      .map((p) => {
        // 推断 vibe
        const inferredVibe = vibes.find((v) =>
          (vibeToPlaceTypes[v] || "").split(",")
            .some((t) => p.types?.includes(t))
        ) || vibes[0] || "hidden";
        const placeArray = normalizePlaceFromAPI(p, inferredVibe, cityCenter);
        return normalizePlace(placeArray, Math.random() * 1000 | 0, "system");
      });
  } catch {
    return [];
  }
}

// 获取真实交通时间（调用 /api/routes），按坐标缓存避免重复请求
async function fetchTravelMatrix(origin, destination) {
  if (!origin?.lat || !origin?.lng || !destination?.lat || !destination?.lng) return null;
  const key = `${origin.lat},${origin.lng}-${destination.lat},${destination.lng}`;
  if (travelMatrixCache.has(key)) return travelMatrixCache.get(key);

  const requestRoute = async (travelMode) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3500);
    const res = await fetch("/api/routes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        origins: [{ lat: origin.lat, lng: origin.lng }],
        destinations: [{ lat: destination.lat, lng: destination.lng }],
        travelMode
      })
    }).finally(() => clearTimeout(timeout));
    if (!res.ok) return null;
    return parseRouteMatrixEntry(await res.json());
  };


  try {
    const [transit, drive] = await Promise.all([
      requestRoute("TRANSIT"),
      requestRoute("DRIVE")
    ]);
    const result = transit || drive ? { transit, drive } : null;
    travelMatrixCache.set(key, result);
    return result;
  } catch {
    travelMatrixCache.set(key, null);
    return null;
  }
}

async function fetchTransitMatrix(origin, destination) {
  if (!origin?.lat || !origin?.lng || !destination?.lat || !destination?.lng) return null;
  const key = `${origin.lat},${origin.lng}-${destination.lat},${destination.lng}`;
  const cached = travelMatrixCache.get(key);
  if (cached?.transit) return cached.transit;


  try {
    const transit = await requestRouteMatrix(origin, destination, "TRANSIT");
    travelMatrixCache.set(key, { ...(cached || {}), transit });
    return transit;
  } catch {
    travelMatrixCache.set(key, cached || null);
    return null;
  }
}

async function fetchDriveMatrix(origin, destination) {
  if (!origin?.lat || !origin?.lng || !destination?.lat || !destination?.lng) return null;
  const key = `${origin.lat},${origin.lng}-${destination.lat},${destination.lng}`;
  const cached = travelMatrixCache.get(key);
  if (cached?.drive) return cached.drive;


  try {
    const drive = await requestRouteMatrix(origin, destination, "DRIVE");
    travelMatrixCache.set(key, { ...(cached || {}), drive });
    return drive;
  } catch {
    travelMatrixCache.set(key, cached || null);
    return null;
  }
}

async function requestRouteMatrix(origin, destination, travelMode) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const res = await fetch("/api/routes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      origins: [{ lat: origin.lat, lng: origin.lng }],
      destinations: [{ lat: destination.lat, lng: destination.lng }],
      travelMode
    })
  }).finally(() => clearTimeout(timeout));
  if (!res.ok) return null;
  return parseRouteMatrixEntry(await res.json());
}

function parseRouteMatrixEntry(data) {
  const entry = Array.isArray(data) ? data[0] : data;
  if (!entry || entry.error || entry.status?.code || entry.condition === "ROUTE_NOT_FOUND") return null;
  const minutes = parseDurationMinutes(entry.duration || entry.localizedValues?.duration?.text);
  if (!minutes) return null;
  return {
    minutes,
    distanceMeters: Number(entry.distanceMeters || 0),
    raw: entry
  };
}

function parseDurationMinutes(value) {
  if (!value) return 0;
  if (typeof value === "number") return Math.round(value / 60);
  const secondsMatch = String(value).match(/^([\d.]+)s$/);
  if (secondsMatch) return Math.round(Number(secondsMatch[1]) / 60);
  const hourMatch = String(value).match(/(\d+)\s*h/i);
  const minuteMatch = String(value).match(/(\d+)\s*m/i);
  if (hourMatch || minuteMatch) {
    return Number(hourMatch?.[1] || 0) * 60 + Number(minuteMatch?.[1] || 0);
  }
  return 0;
}

async function preloadTravelMatrices(places = [], hotelAreas = []) {
  const importantPlaces = places
    .filter((place) => place?.lat && place?.lng)
    .sort((a, b) => (b.nominations?.length || 0) - (a.nominations?.length || 0))
    .slice(0, 18);
  const hotels = hotelAreas.filter((hotel) => hotel?.lat && hotel?.lng);
  const jobs = [];

  for (const hotel of hotels) {
    for (const place of importantPlaces) {
      jobs.push([hotel, place]);
      jobs.push([place, hotel]);
    }
  }

  for (let i = 0; i < importantPlaces.length; i += 1) {
    for (let j = i + 1; j < importantPlaces.length; j += 1) {
      if (importantPlaces[i].city && importantPlaces[j].city && importantPlaces[i].city !== importantPlaces[j].city) continue;
      jobs.push([importantPlaces[i], importantPlaces[j]]);
      jobs.push([importantPlaces[j], importantPlaces[i]]);
    }
  }

  const cappedJobs = jobs.slice(0, 160);
  const workers = Array.from({ length: 6 }, async (_, workerIndex) => {
    for (let index = workerIndex; index < cappedJobs.length; index += 6) {
      const [origin, destination] = cappedJobs[index];
      await fetchTravelMatrix(origin, destination);
    }
  });
  await Promise.race([
    Promise.all(workers),
    new Promise((resolve) => setTimeout(resolve, 7000))
  ]);
}

function getCachedTravelMatrix(origin, destination) {
  if (!origin?.lat || !origin?.lng || !destination?.lat || !destination?.lng) return null;
  const key = `${origin.lat},${origin.lng}-${destination.lat},${destination.lng}`;
  return travelMatrixCache.get(key) || null;
}

// 提名搜索防抖
let nominationDebounceTimer = null;

async function searchNominationPlaces(query, cityCenter) {
  console.log("searchNominationPlaces called:", query, cityCenter);
  if (!query || query.length < 2) return [];

  try {
    const params = new URLSearchParams({
      query,
      type: "nomination",
      ...(cityCenter ? {
        lat: cityCenter.lat,
        lng: cityCenter.lng
      } : {})
    });
    const url = `/api/places?${params}`;
    console.log("Fetching:", url);
    const res = await fetch(url);
    const data = await res.json();
    console.log("API result:", data);
    console.log("raw API response:", data);
    console.log("places array:", data.places);
    return data.places || [];
  } catch (e) {
    console.error("searchNominationPlaces error:", e);
    return [];
  }
}

function showNominationSuggestions(wrap, results) {
  console.log("showNominationSuggestions called:", wrap, results.length);
  const ul = wrap?.querySelector(".nomination-suggestions");
  console.log("ul element:", ul);
  if (!ul) return;
  if (!results.length) {
    ul.style.display = "none";
    return;
  }
  ul.innerHTML = results.map((p) => `
    <li class="nomination-suggestion-item"
        data-place-name="${p.displayName?.text || ""}"
        data-place-address="${p.formattedAddress || ""}">
      <strong>${p.displayName?.text || ""}</strong>
      <span>${p.formattedAddress || ""}</span>
    </li>
  `).join("");
  ul.style.display = "block";
}

const vibeOptions = [
  ["slow-cafe", "慢咖啡", "安静街角、独立咖啡馆、可步行社区", "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=600&q=80"],
  ["architecture", "建筑巡礼", "现代建筑、老街立面、设计空间", "https://images.unsplash.com/photo-1480714378408-67cf0d13bc1f?auto=format&fit=crop&w=600&q=80"],
  ["night", "夜色微醺", "夜景、酒吧、霓虹与深夜食堂", "https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=600&q=80"],
  ["nature", "自然松弛", "公园、海岸、森林与低密度动线", "https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=600&q=80"],
  ["museum", "美术馆日", "展览、书店、画廊与文艺街区", "https://images.unsplash.com/photo-1518998053901-5348d3961a04?auto=format&fit=crop&w=600&q=80"],
  ["local-food", "本地烟火", "市场、小店、排队美食和街头气味", "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=600&q=80"],
  ["retro", "复古电影", "胶片感街巷、旧物店、低饱和色调", "https://images.unsplash.com/photo-1516834474-48c0abc2a902?auto=format&fit=crop&w=600&q=80"],
  ["luxury", "精致享受", "高评分餐厅、酒店景观、舒适交通", "https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?auto=format&fit=crop&w=600&q=80"],
  ["family", "轻松亲友", "少折返、低风险、适合结伴集合", "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=600&q=80"],
  ["shopping", "买手地图", "设计品牌、古着、生活方式集合店", "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=600&q=80"],
  ["history", "历史漫游", "寺庙、旧城、博物馆和城市记忆", "https://images.unsplash.com/photo-1526481280693-3bfa7568e0f3?auto=format&fit=crop&w=600&q=80"],
  ["hidden", "小众隐线", "避开游客潮、深入社区和冷门地标", "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=600&q=80"]
];

const DAY_COLORS = [
  "#6c5ce7", "#00cec9", "#fd79a8", "#f0a04b", "#a29bfe"
];

// 打车费用参考单价表（USD，白天基础价，仅供参考）
// 数据来源：各国出租车协会/政府公示计价标准，汇率按近似值换算
// 如需更新：修改 base（起步价）和 perKm（每公里单价）即可
const taxiRateUSD = {
  "Japan": { base: 4.5, perKm: 3.8 }, // 日本全国均值，东京略高
  "South Korea": { base: 3.0, perKm: 1.3 }, // 首尔普通计程车
  "Thailand": { base: 1.5, perKm: 0.7 }, // 曼谷起步35泰铢
  "Singapore": { base: 3.5, perKm: 1.5 }, // 含ERP路费估算
  "France": { base: 4.5, perKm: 2.3 }, // 巴黎G7标准
  "Italy": { base: 4.0, perKm: 1.8 }, // 罗马/米兰市区
  "Spain": { base: 3.5, perKm: 1.5 }, // 马德里/巴塞罗那
  "UK": { base: 5.0, perKm: 3.2 }, // 伦敦黑的士
  "Germany": { base: 4.0, perKm: 2.0 }, // 柏林/慕尼黑
  "USA": { base: 3.5, perKm: 2.0 }, // 纽约/LA Uber均值
  "Australia": { base: 4.0, perKm: 1.8 }, // 悉尼/墨尔本
  "UAE": { base: 3.0, perKm: 1.2 }, // 迪拜RTA标准
  "default": { base: 3.0, perKm: 1.8 } // 未收录国家的fallback
};

const countryCities = {
  Japan: ["Tokyo", "Osaka", "Kyoto", "Hiroshima", "Nara", "Sapporo", "Fukuoka", "Yokohama", "Kamakura", "Nikko"],
  UK: ["London", "Manchester", "Birmingham", "Edinburgh", "Liverpool", "Bristol", "Brighton", "Oxford", "Cambridge", "Bath"],
  France: ["Paris", "Nice", "Lyon", "Marseille", "Bordeaux", "Strasbourg", "Toulouse", "Cannes", "Mont Saint-Michel", "Versailles"],
  Germany: ["Berlin", "Munich", "Hamburg", "Frankfurt", "Cologne", "Dresden", "Heidelberg", "Stuttgart", "Nuremberg", "Düsseldorf"],
  Spain: ["Barcelona", "Madrid", "Seville", "Valencia", "Granada", "Bilbao", "Toledo", "Salamanca", "San Sebastián", "Málaga"],
  Italy: ["Rome", "Florence", "Venice", "Milan", "Naples", "Amalfi Coast", "Cinque Terre", "Bologna", "Siena", "Verona"],
  "South Korea": ["Seoul", "Busan", "Jeju", "Gyeongju", "Incheon", "Daegu"],
  Thailand: ["Bangkok", "Chiang Mai", "Phuket", "Krabi", "Ayutthaya", "Pattaya"],
  Singapore: ["Singapore"],
  China: ["Beijing", "Shanghai", "Chengdu", "Xi'an", "Hangzhou", "Guangzhou"],
  Australia: ["Sydney", "Melbourne", "Brisbane", "Perth", "Adelaide", "Cairns"],
  UAE: ["Dubai", "Abu Dhabi", "Sharjah"],
  Netherlands: ["Amsterdam", "Rotterdam", "The Hague", "Utrecht"],
  Portugal: ["Lisbon", "Porto", "Sintra", "Faro"],
  Norway: ["Oslo", "Bergen", "Tromsø", "Stavanger", "Trondheim", "Ålesund", "Flåm", "Geirangerfjord", "Lofoten", "Kristiansand"],
  Finland: ["Helsinki", "Rovaniemi", "Tampere", "Turku", "Oulu", "Lappeenranta", "Espoo", "Porvoo", "Savonlinna", "Inari"],
  Switzerland: ["Zurich", "Geneva", "Lucerne", "Interlaken", "Bern"],
  Austria: ["Vienna", "Salzburg", "Innsbruck", "Graz"],
  Greece: ["Athens", "Santorini", "Mykonos", "Thessaloniki"],
  Turkey: ["Istanbul", "Cappadocia", "Antalya", "Izmir"],
  Canada: ["Toronto", "Vancouver", "Montreal", "Quebec City", "Calgary"],
  Mexico: ["Mexico City", "Cancun", "Oaxaca", "Guadalajara"],
  Indonesia: ["Bali", "Jakarta", "Yogyakarta", "Ubud"],
  Vietnam: ["Hanoi", "Ho Chi Minh City", "Da Nang", "Hoi An"],
  Malaysia: ["Kuala Lumpur", "Penang", "Langkawi", "Malacca"],
  "New Zealand": ["Auckland", "Queenstown", "Wellington", "Christchurch"],
  "Czech Republic": ["Prague", "Český Krumlov", "Brno"],
  Hungary: ["Budapest", "Eger", "Pécs"],
  Ireland: ["Dublin", "Galway", "Cork"],
  Denmark: ["Copenhagen", "Aarhus", "Odense"],
  Sweden: ["Stockholm", "Gothenburg", "Malmö"],
  Belgium: ["Brussels", "Bruges", "Antwerp", "Ghent"],
  Croatia: ["Dubrovnik", "Split", "Zagreb", "Hvar"],
  USA: ["New York City", "Los Angeles", "San Francisco", "Las Vegas", "Miami", "Chicago", "New Orleans", "Seattle", "Washington DC", "Honolulu"]
};

// 酒店每晚费用参考单价表（USD，每间房，白天基础价，仅供参考）
// 数据来源：各国主要旅游城市酒店均价（USD/间/晚，2024-2025年参考值）
// 如需更新：修改对应国家的星级价格即可
const hotelCostByCountry = {
  "Japan": { 1: 50, 2: 90, 3: 150, 4: 250, 5: 500 }, // 东京/京都均值
  "South Korea": { 1: 45, 2: 80, 3: 130, 4: 200, 5: 400 }, // 首尔均值
  "Thailand": { 1: 25, 2: 50, 3: 90, 4: 150, 5: 350 }, // 曼谷均值
  "Singapore": { 1: 80, 2: 140, 3: 220, 4: 350, 5: 700 }, // 新加坡均值
  "France": { 1: 80, 2: 130, 3: 200, 4: 350, 5: 700 }, // 巴黎均值
  "Italy": { 1: 70, 2: 120, 3: 180, 4: 300, 5: 600 }, // 罗马/米兰均值
  "Spain": { 1: 60, 2: 100, 3: 160, 4: 260, 5: 500 }, // 马德里/巴塞罗那均值
  "UK": { 1: 90, 2: 150, 3: 230, 4: 380, 5: 750 }, // 伦敦均值
  "Germany": { 1: 70, 2: 110, 3: 170, 4: 280, 5: 550 }, // 柏林/慕尼黑均值
  "USA": { 1: 80, 2: 130, 3: 200, 4: 320, 5: 650 }, // 纽约/LA均值
  "Australia": { 1: 80, 2: 130, 3: 200, 4: 300, 5: 600 }, // 悉尼/墨尔本均值
  "UAE": { 1: 70, 2: 120, 3: 200, 4: 350, 5: 700 }, // 迪拜均值
  "China": { 1: 30, 2: 60, 3: 100, 4: 180, 5: 400 }, // 北京/上海均值
  "Indonesia": { 1: 25, 2: 50, 3: 90, 4: 160, 5: 350 }, // 巴厘岛/雅加达均值
  "Vietnam": { 1: 20, 2: 40, 3: 80, 4: 140, 5: 300 }, // 河内/胡志明均值
  "Portugal": { 1: 60, 2: 100, 3: 160, 4: 260, 5: 500 }, // 里斯本均值
  "Netherlands": { 1: 80, 2: 130, 3: 200, 4: 320, 5: 600 }, // 阿姆斯特丹均值
  "default": { 1: 50, 2: 90, 3: 140, 4: 230, 5: 450 } // 未收录国家fallback
};
const airportCoords = {
  NRT: { x: 90, y: 15 },
  HND: { x: 45, y: 85 },
  LHR: { x: 18, y: 45 },
  CDG: { x: 75, y: 18 },
  BER: { x: 68, y: 22 },
  FCO: { x: 62, y: 78 },
  BCN: { x: 72, y: 65 },
  OSL: { x: 55, y: 20 },
  HEL: { x: 70, y: 25 },
  JFK: { x: 82, y: 72 },
  LAX: { x: 22, y: 68 },
  SFO: { x: 18, y: 55 }
};

const transportIcons = ["🚶", "🚌", "🚇", "🚕"];
const algorithmWeights = {
  nominationScore: 0.45,
  groupConsensus: 0.25,
  budgetFit: 0.15,
  routeEfficiency: 0.15
};
const rankWeights = { 1: 100, 2: 67, 3: 33 };
const maxTravelByMode = { TRANSIT: 50, DRIVING: 60 };
const cityTransferMaxStops = {
  train: 2,
  flight: 1,
  bus: 1
};
const minimumCandidatePool = 8;

function getMaxPerVibe(days) {
  return Math.max(3, Math.ceil(days * 0.8));
}

function getDay1MaxStops(arrivalTime) {
  if (!arrivalTime) return 3;
  const [h, m] = arrivalTime.split(":").map(Number);
  const arrivalMinutes = h * 60 + m + 150;
  if (arrivalMinutes <= 14 * 60) return 2;
  if (arrivalMinutes <= 18 * 60) return 1;
  return 0;
}

const demoTravelers = [
  { name: "Mia", role: "文化策展", budget: "$1.6k", vibes: ["museum", "architecture", "slow-cafe"], mustVisits: ["", "", ""], color: "#1c6b7a" },
  { name: "Alex", role: "美食探索", budget: "$2.1k", vibes: ["local-food", "night", "hidden"], mustVisits: ["", "", ""], color: "#d85d47" },
  { name: "Jo", role: "低风险路线", budget: "$1.4k", vibes: ["family", "nature", "history"], mustVisits: ["", "", ""], color: "#0f8f73" }
];
const travelers = [
  { name: "Planner", role: "主规划人", budget: "$1.6k", vibes: ["museum", "architecture", "slow-cafe"], mustVisits: ["", "", ""], color: "#1c6b7a" }
];

function normalizeMustVisits(mustVisits = []) {
  const list = Array.isArray(mustVisits) ? mustVisits.slice(0, 3) : [];
  while (list.length < 3) list.push("");
  return list;
}

const state = {
  latestTrip: null,
  activeIndex: 0,
  language: "zh",
  countryCode: "JP",
  nationalityCode: "CN",
  departureAirport: "UNKNOWN",
  departureAirportName: "",
  departureAirportCoords: null,
  flightDepartureTime: "14:00",
  arrivalAirport: "UNKNOWN",
  arrivalAirportName: "",
  arrivalAirportCoords: null,
  flightArrivalTime: "",
  cityTransferModes: {},
  cities: ["Tokyo"]
};
let cityCentersCache = {};

const i18n = {
  zh: {
    hero: "把一群人的偏好合成一条可执行路线",
    destination: "目的地国家",
    city: "目的地城市",
    days: "旅行天数",
    travelerCount: "出行人数",
    budgetMin: "单人总行程预算下限",
    budgetMax: "单人总行程预算上限",
    discovery: "发现模式",
    transport: "交通方式",
    hotelStars: "酒店星级",
    departureAirport: "出发机场",
    flightDepartureTime: "航班起飞时间（最后一天）",
    arrivalAirport: "到达机场",
    flightArrivalTime: "航班到达时间（第一天）",
    cityTransfer: "换城交通",
    nationality: "主预订人国籍",
    departure: "出发日期",
    language: "语言",
    guide: "使用指引",
    hotelAreas: "每日酒店 / 住宿区域",
    applyAll: "全部套用",
    travelerPrefs: "每位同行者的氛围和必去地点",
    generate: "合成团队行程",
    workspaceEyebrow: "多人行程优化",
    share: "邀请队友查看",
    personaLabel: "团队画像合成",
    algorithmLabel: "路线生成算法",
    budgetMonitor: "预算监控",
    modes: "步行 / 公交 / 驾车",
    consensusRoute: "共识路线",
    reservePool: "备选地点池",
    countryNames: {
      Japan: "日本", France: "法国", UK: "英国", USA: "美国", Germany: "德国", Italy: "意大利", Spain: "西班牙",
      "South Korea": "韩国", Thailand: "泰国", Singapore: "新加坡", China: "中国", Australia: "澳大利亚", UAE: "阿联酋",
      Netherlands: "荷兰", Portugal: "葡萄牙", Norway: "挪威", Finland: "芬兰", Switzerland: "瑞士", Austria: "奥地利",
      Greece: "希腊", Turkey: "土耳其", Canada: "加拿大", Mexico: "墨西哥", Indonesia: "印度尼西亚", Vietnam: "越南",
      Malaysia: "马来西亚", "New Zealand": "新西兰", "Czech Republic": "捷克", Hungary: "匈牙利", Ireland: "爱尔兰",
      Denmark: "丹麦", Sweden: "瑞典", Belgium: "比利时", Croatia: "克罗地亚"
    },
    nationalityNames: { CN: "中国大陆", SG: "新加坡", US: "美国", MY: "马来西亚" },
    vibeNames: {
      "slow-cafe": "慢咖啡", architecture: "建筑巡礼", night: "夜色微醺", nature: "自然松弛",
      museum: "美术馆日", "local-food": "本地烟火", retro: "复古电影", luxury: "精致享受",
      family: "轻松亲友", shopping: "买手地图", history: "历史漫游", hidden: "小众隐线"
    }
  },
  en: {
    hero: "Turn group preferences into an executable trip plan",
    destination: "Destination country",
    city: "Destination city",
    days: "Travel days",
    travelerCount: "Traveler count",
    budgetMin: "Per-person total budget min",
    budgetMax: "Per-person total budget max",
    discovery: "Discovery mode",
    transport: "Transport mode",
    hotelStars: "Hotel star level",
    departureAirport: "Departure airport",
    flightDepartureTime: "Flight departure time (last day)",
    arrivalAirport: "Arrival airport",
    flightArrivalTime: "Flight arrival time (Day 1)",
    cityTransfer: "City transfer",
    nationality: "Lead traveler nationality",
    departure: "Departure date",
    language: "Language",
    guide: "Guide",
    hotelAreas: "Hotel / accommodation area by day",
    applyAll: "Apply all",
    travelerPrefs: "Vibes and must-visit places per traveler",
    generate: "Generate group itinerary",
    workspaceEyebrow: "Group itinerary optimization",
    share: "Invite teammates",
    personaLabel: "Group profile synthesis",
    algorithmLabel: "Route generation algorithm",
    budgetMonitor: "Budget monitor",
    modes: "Walk / Transit / Drive",
    consensusRoute: "Consensus route",
    reservePool: "Reserve candidate pool",
    countryNames: {
      Japan: "Japan", France: "France", UK: "United Kingdom", USA: "United States", Germany: "Germany", Italy: "Italy", Spain: "Spain",
      "South Korea": "South Korea", Thailand: "Thailand", Singapore: "Singapore", China: "China", Australia: "Australia", UAE: "United Arab Emirates",
      Netherlands: "Netherlands", Portugal: "Portugal", Norway: "Norway", Finland: "Finland", Switzerland: "Switzerland", Austria: "Austria",
      Greece: "Greece", Turkey: "Turkey", Canada: "Canada", Mexico: "Mexico", Indonesia: "Indonesia", Vietnam: "Vietnam",
      Malaysia: "Malaysia", "New Zealand": "New Zealand", "Czech Republic": "Czech Republic", Hungary: "Hungary", Ireland: "Ireland",
      Denmark: "Denmark", Sweden: "Sweden", Belgium: "Belgium", Croatia: "Croatia"
    },
    nationalityNames: { CN: "Mainland China", SG: "Singapore", US: "United States", MY: "Malaysia" },
    vibeNames: {
      "slow-cafe": "Slow cafes", architecture: "Architecture", night: "Nightlife", nature: "Nature",
      museum: "Museums", "local-food": "Local food", retro: "Retro", luxury: "Premium comfort",
      family: "Easy group pace", shopping: "Shopping", history: "History", hidden: "Hidden gems"
    }
  }
};

const form = document.querySelector("#trip-form");
const travelerList = document.querySelector("#traveler-list");
const countryInput = document.querySelector("#country");
const countryTags = document.querySelector("#country-tags");
const destinationInput = document.querySelector("#destination");
const cityTags = document.querySelector("#city-tags");
const cityAddSelect = document.querySelector("#city-add-select");
const cityAddBtn = document.querySelector("#city-add-btn");
const hotelAreaList = document.querySelector("#hotel-area-list");
const applyHotelAll = document.querySelector("#apply-hotel-all");
const departureInput = document.querySelector("#departure");
const nationalityInput = document.querySelector("#nationality");
const daysInput = document.querySelector("#days");
const travelerCountInput = document.querySelector("#traveler-count");
const budgetMinInput = document.querySelector("#budget-min");
const budgetMaxInput = document.querySelector("#budget-max");
const discoveryModeInput = document.querySelector("#discovery-mode");
const transportModeInput = document.querySelector("#transport-mode");
const hotelStarsInput = document.querySelector("#hotel-stars");
const departureAirportInput = document.querySelector("#departure-airport");
const flightDepTimeInput = document.querySelector("#flight-dep-time");
const flightTimeLabelEl = document.querySelector("#flight-time-label");
const arrivalAirportInput = document.querySelector("#arrival-airport");
const flightArrivalTimeInput = document.querySelector("#flight-arrival-time");
const arrivalTimeLabelEl = document.querySelector("#arrival-time-label");
const languageInput = document.querySelector("#language");
const guideButton = document.querySelector("#guide-button");
const title = document.querySelector("#workspace-title");
const itineraryDisclaimer = document.querySelector("#itinerary-disclaimer");
const personaCopy = document.querySelector("#persona-copy");
const alertStack = document.querySelector("#alert-stack");
const budgetTotal = document.querySelector("#budget-total");
const budgetFill = document.querySelector("#budget-fill");
const budgetCaption = document.querySelector("#budget-caption");
const algorithmCopy = document.querySelector("#algorithm-copy");
const routeSummary = document.querySelector("#route-summary");
const routeLines = document.querySelector("#route-lines");
const mapPoints = document.querySelector("#map-points");
const itineraryList = document.querySelector("#itinerary-list");
const placeCount = document.querySelector("#place-count");
const reservePoolSection = document.querySelector("#reserve-pool-section");
const reservePoolList = document.querySelector("#reserve-pool-list");
const reservePoolCount = document.querySelector("#reserve-pool-count");
const reservePoolTitle = document.querySelector("#reserve-pool-title");
const regenerate = document.querySelector("#regenerate");
const exportPdfButton = document.querySelector("#export-pdf");
const pdfExport = document.querySelector("#pdf-export");
let shareButton = null;
const dialog = document.querySelector("#detail-dialog");
const closeDialog = document.querySelector("#close-dialog");
const detailImage = document.querySelector("#detail-image");
const detailKicker = document.querySelector("#detail-kicker");
const detailTitle = document.querySelector("#detail-title");
const detailBody = document.querySelector("#detail-body");
const toast = document.querySelector("#toast");

function getTripIdFromPath() {
  const match = window.location.pathname.match(/^\/trip\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function bindShareButtonEvents() {
  shareButton = document.querySelector("#share");
  if (!shareButton || shareButton.dataset.eventsBound === "true") return;
  shareButton.dataset.eventsBound = "true";
  shareButton.addEventListener("click", async () => {
    try {
      shareButton.disabled = true;
      shareButton.textContent = state.language === "en" ? "Creating..." : "创建中...";
      const existingTripId = window._activeTripId || activeInviteTrip?.id || sharedTripId;
      if (existingTripId) {
        showInviteModal(`${window.location.origin}/trip/${existingTripId}`, existingTripId);
      } else {
        await createInviteTrip();
      }
      showToast(state.language === "en" ? "Invite created" : "邀请已创建");
    } catch (error) {
      console.error(error);
      showToast(state.language === "en" ? "Invite failed. Check Supabase config." : "邀请创建失败，请检查 Supabase 配置。");
    } finally {
      shareButton.disabled = false;
      shareButton.textContent = t("share");
    }
  });
}

const guideSteps = [
  {
    key: "destination",
    selector: '[data-guide-target="destination"]',
    zh: { title: "目的地", description: "选择你们想去的目的地，可以添加多个城市" },
    en: { title: "Destination", description: "Choose where your group wants to go. You can add multiple cities." }
  },
  {
    key: "settings",
    selector: '[data-guide-target="settings"]',
    zh: { title: "行程设置", description: "设置天数、人数和每人预算范围" },
    en: { title: "Trip settings", description: "Set days, traveler count, and the per-person budget range." }
  },
  {
    key: "surprise",
    selector: '[data-guide-target="surprise"]',
    zh: { title: "发现模式", description: "开启「惊喜模式」后，系统会在你们的提名地点之外，自动推荐符合团队氛围的隐藏好去处，让行程更有惊喜感。关闭后只显示提名地点。" },
    en: { title: "Surprise Mode", description: "With Surprise Mode ON, the system automatically recommends hidden gems that match your group's vibe, beyond your nominated places. Turn it OFF to only include nominated places." }
  },
  {
    key: "preferences",
    selector: '[data-guide-target="preferences"]',
    zh: { title: "我的偏好", description: "选择你喜欢的氛围，填写最想去的地方" },
    en: { title: "My preferences", description: "Pick your favorite vibes and enter the places you most want to visit." }
  },
  {
    key: "invite",
    selector: '[data-guide-target="invite"]',
    zh: { title: "邀请队友", description: "生成邀请链接，让队友填写各自的偏好" },
    en: { title: "Invite", description: "Create an invite link so teammates can add their own preferences." }
  },
  {
    key: "auto-generate",
    selector: ".itinerary-panel, #result",
    zh: { title: "自动生成", description: "填写完成后，行程会自动合成。邀请队友后，所有人填写完毕，点击共享页面的「合成团队行程」即可生成。" },
    en: { title: "Auto-generate", description: "The itinerary generates automatically after you fill in your preferences. When using the invite flow, click 'Generate Trip' on the shared page after everyone fills in." }
  },
  {
    key: "reserve",
    selector: '[data-guide-target="reserve"]',
    zh: { title: "备选池", description: "行程生成后，可以在备选池点击 🤍 标记想去的地方，或点击「加入行程」手动加入某一天。" },
    en: { title: "Reserve pool", description: "After the itinerary is generated, tap 🤍 to mark places you want to visit, or click 'Add to itinerary' to manually add a place to a specific day." }
  },
  {
    key: "export-pdf",
    selector: '[data-guide-target="export-pdf"]',
    zh: { title: "导出 PDF", description: "行程生成后，点击「导出 PDF」按钮，可以将完整行程保存为 PDF 文件，方便离线查看或分享给队友。" },
    en: { title: "Export PDF", description: "After the itinerary is generated, click 'Export PDF' to save the complete itinerary as a PDF file for offline viewing or sharing with teammates." }
  }
];

function bindGuideEvents() {
  guideButton?.addEventListener("click", () => startGuide());
}

function startGuide() {
  endGuide();
  guideState = {
    index: 0,
    overlay: document.createElement("div"),
    spotlight: document.createElement("div"),
    tooltip: document.createElement("div")
  };
  guideState.overlay.className = "guide-overlay";
  guideState.spotlight.className = "guide-spotlight";
  guideState.tooltip.className = "guide-tooltip";
  document.body.append(guideState.overlay, guideState.spotlight, guideState.tooltip);
  window.addEventListener("resize", positionGuide);
  window.addEventListener("scroll", positionGuide, true);
  renderGuideStep();
}

function endGuide() {
  if (!guideState) return;
  guideState.overlay.remove();
  guideState.spotlight.remove();
  guideState.tooltip.remove();
  window.removeEventListener("resize", positionGuide);
  window.removeEventListener("scroll", positionGuide, true);
  guideState = null;
}

function renderGuideStep() {
  if (!guideState) return;
  const step = guideSteps[guideState.index];
  const target = document.querySelector(step.selector) || document.body;
  target.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
  setTimeout(positionGuide, 260);

  const lang = state.language === "en" ? "en" : "zh";
  const copy = step[lang];
  const isLast = guideState.index === guideSteps.length - 1;
  guideState.tooltip.innerHTML = `
    <div class="guide-step-count">${guideState.index + 1}/${guideSteps.length}</div>
    <h3>${copy.title}</h3>
    <p>${copy.description}</p>
    <div class="guide-dots">
      ${guideSteps.map((_, index) => `<span class="${index === guideState.index ? "active" : ""}"></span>`).join("")}
    </div>
    <div class="guide-actions">
      <button class="text-button guide-skip" type="button">${lang === "en" ? "Skip" : "跳过"}</button>
      <button class="primary-button guide-next" type="button">${isLast ? (lang === "en" ? "Get started" : "开始使用") : (lang === "en" ? "Next" : "下一步")}</button>
    </div>
  `;
  guideState.tooltip.querySelector(".guide-skip")?.addEventListener("click", endGuide);
  guideState.tooltip.querySelector(".guide-next")?.addEventListener("click", () => {
    if (isLast) {
      endGuide();
      return;
    }
    guideState.index += 1;
    renderGuideStep();
  });
}

function positionGuide() {
  if (!guideState) return;
  const step = guideSteps[guideState.index];
  const target = document.querySelector(step.selector) || document.body;
  const rect = target.getBoundingClientRect();
  const padding = 10;
  const top = Math.max(10, rect.top - padding);
  const left = Math.max(10, rect.left - padding);
  const width = Math.min(window.innerWidth - left - 10, rect.width + padding * 2);
  const height = Math.min(window.innerHeight - top - 10, rect.height + padding * 2);

  Object.assign(guideState.spotlight.style, {
    top: `${top}px`,
    left: `${left}px`,
    width: `${width}px`,
    height: `${height}px`
  });

  const tooltipWidth = Math.min(340, window.innerWidth - 28);
  let tooltipTop = top + height + 16;
  if (tooltipTop + 230 > window.innerHeight) tooltipTop = Math.max(14, top - 230);
  let tooltipLeft = left;
  if (tooltipLeft + tooltipWidth > window.innerWidth - 14) {
    tooltipLeft = window.innerWidth - tooltipWidth - 14;
  }
  Object.assign(guideState.tooltip.style, {
    width: `${tooltipWidth}px`,
    top: `${tooltipTop}px`,
    left: `${Math.max(14, tooltipLeft)}px`
  });
}

function init() {
  console.log("init() started");
  bindShareButtonEvents();
  bindGuideEvents();
  departureInput.valueAsDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 21);
  applyLanguage();
  renderCityOptions("Tokyo");
  renderCityTags();
  console.log("about to renderTravelers, travelerList:", travelerList);
  renderTravelers();
  console.log("travelerList element:", travelerList);
  bindTravelerListEvents();
  updateFlightTimeVisibility();
  // 等 Google Maps JS 加载完再初始化地图
  if (window.google) {
    initGoogleMap();
    initCountryAutocomplete();
    initCityAutocomplete();
    initAirportAutocomplete();
  } else {
    window.addEventListener("load", () => {
      initGoogleMap();
      initCountryAutocomplete();
      initCityAutocomplete();
      initAirportAutocomplete();
    });
  }
  const pathTripId = getTripIdFromPath();
  console.log("pathTripId:", pathTripId);
  if (pathTripId) {
    loadSharedTrip(pathTripId).catch(console.error);
    return;
  }
  restoreFromHash();
  generateTrip().catch(console.error);
  restoreInviteTripFromQuery().catch(console.error);
}

function initGoogleMap() {
  const mapEl = document.getElementById("google-map");
  if (!mapEl || !window.google) return;

  googleMap = new google.maps.Map(mapEl, {
    zoom: 12,
    center: { lat: 35.6762, lng: 139.6503 },
    mapTypeId: "roadmap",
    styles: [
      { featureType: "poi", stylers: [{ visibility: "off" }] },
      { featureType: "transit", stylers: [{ visibility: "simplified" }] }
    ],
    disableDefaultUI: false,
    zoomControl: true,
    streetViewControl: false,
    mapTypeControl: false
  });
}

function clearMap() {
  mapMarkers.forEach((marker) => marker.setMap(null));
  mapPolylines.forEach((polyline) => polyline.setMap(null));
  mapMarkers = [];
  mapPolylines = [];
}

function bindTravelerListEvents() {
  if (!travelerList || travelerList.dataset.eventsBound === "true") return;
  travelerList.dataset.eventsBound = "true";

  travelerList.addEventListener("click", (event) => {
    // 选择提名建议
    const suggestionItem = event.target.closest(".nomination-suggestion-item");
    if (suggestionItem) {
      const wrap = suggestionItem.closest(".nomination-wrap");
      const input = wrap.querySelector(".nomination-input");
      const travelerCard = wrap.closest("[data-traveler]");
      const travelerIdx = Number(travelerCard.dataset.traveler);
      if (sharedTripId && travelers[travelerIdx]?.name !== currentSharedMemberName) return;
      const placeIdx = Number(wrap.dataset.placeIdx);
      const placeName = suggestionItem.dataset.placeName;

      input.value = placeName;
      travelers[travelerIdx].mustVisits[placeIdx] = placeName;
      wrap.querySelector(".nomination-suggestions")
        .style.display = "none";
      scheduleSharedMemberSave();
      generateTrip().catch(console.error);
      return;
    }

    const vibeButton = event.target.closest("[data-vibe]");
    if (!vibeButton) return;
    const card = event.target.closest("[data-traveler]");
    const traveler = travelers[Number(card.dataset.traveler)];
    if (sharedTripId && traveler?.name !== currentSharedMemberName) return;
    const vibe = vibeButton.dataset.vibe;
    if (traveler.vibes.includes(vibe)) {
      traveler.vibes = traveler.vibes.filter((item) => item !== vibe);
    } else {
      traveler.vibes = [...traveler.vibes, vibe];
    }
    renderTravelers();
    scheduleSharedMemberSave();
  });

  travelerList.addEventListener("input", (event) => {
    console.log("travelerList input fired", event.target.className);

    // 原有的 must-visit 文字更新逻辑
    const input = event.target.closest("[data-must-visit]");
    if (input) {
      const card = event.target.closest("[data-traveler]");
      const traveler = travelers[Number(card.dataset.traveler)];
      if (sharedTripId && traveler?.name !== currentSharedMemberName) return;
      traveler
        .mustVisits[Number(input.dataset.mustVisit)] = input.value;
      scheduleSharedMemberSave();
    }

    // 提名搜索逻辑
    const nominationInput = event.target.closest(".nomination-input");
    if (nominationInput) {
      console.log("nomination input detected:", nominationInput.value);
      const wrap = nominationInput.closest(".nomination-wrap");
      clearTimeout(nominationDebounceTimer);
      nominationDebounceTimer = setTimeout(async () => {
        const query = nominationInput.value.trim();
        console.log("debounced query:", query);
        if (query.length < 2) {
          wrap.querySelector(".nomination-suggestions")
            .style.display = "none";
          return;
        }
        const cityCenter = state.latestTrip?.cityCenter || null;
        const results = await searchNominationPlaces(
          query, cityCenter
        );
        console.log("suggestions results:", results);
        console.log("wrap element:", wrap);
        console.log("wrap html:", wrap?.innerHTML);
        showNominationSuggestions(wrap, results);
      }, 300);
    }
  });
}

function updateFlightTimeVisibility() {
  if (!flightTimeLabelEl) return;
  flightTimeLabelEl.style.display = departureAirportInput.value === "UNKNOWN" ? "none" : "";
  if (arrivalTimeLabelEl && arrivalAirportInput) {
    arrivalTimeLabelEl.style.display = arrivalAirportInput.value === "UNKNOWN" ? "none" : "";
  }
}

function t(key) {
  return i18n[state.language][key] ?? i18n.zh[key] ?? key;
}

function applyLanguage() {
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  if (countryInput) countryInput.placeholder = state.language === "en" ? "Search country" : "搜索国家";
  if (departureAirportInput) departureAirportInput.placeholder = state.language === "en" ? "Search airport..." : "搜索机场...";
  if (arrivalAirportInput) arrivalAirportInput.placeholder = state.language === "en" ? "Search airport..." : "搜索机场...";
  Object.entries(t("nationalityNames")).forEach(([value, label]) => {
    const option = nationalityInput.querySelector(`option[value="${value}"]`);
    if (option) option.textContent = label;
  });
  languageInput.value = state.language;
  renderCountryTag();
}

function renderCityOptions(selectedCity) {
  const presetCities = countryInput.value ? (countryCities[countryInput.value] || []) : [];
  const cities = [...new Set([selectedCity, ...(state.cities || []), ...presetCities].filter(Boolean))];
  destinationInput.innerHTML = cities
    .map((city) => `<option value="${city}" ${city === selectedCity ? "selected" : ""}>${city}</option>`)
    .join("");
  if (!cities.includes(destinationInput.value)) destinationInput.value = selectedCity || cities[0] || "";
}

const countryCodeByName = {
  Japan: "JP",
  France: "FR",
  UK: "GB",
  "United Kingdom": "GB",
  USA: "US",
  "United States": "US",
  Germany: "DE",
  Italy: "IT",
  Spain: "ES",
  "South Korea": "KR",
  Thailand: "TH",
  Singapore: "SG",
  China: "CN",
  Australia: "AU",
  UAE: "AE",
  "United Arab Emirates": "AE",
  Netherlands: "NL",
  Portugal: "PT",
  Norway: "NO",
  Finland: "FI",
  Switzerland: "CH",
  Austria: "AT",
  Greece: "GR",
  Turkey: "TR",
  Canada: "CA",
  Mexico: "MX",
  Indonesia: "ID",
  Vietnam: "VN",
  Malaysia: "MY",
  "New Zealand": "NZ",
  "Czech Republic": "CZ",
  Czechia: "CZ",
  Hungary: "HU",
  Ireland: "IE",
  Denmark: "DK",
  Sweden: "SE",
  Belgium: "BE",
  Croatia: "HR"
};

function normalizeCountryName(name = "") {
  const clean = String(name || "").trim();
  const aliases = {
    "United States": "USA",
    "United States of America": "USA",
    "United Kingdom": "UK",
    "South Korea": "South Korea",
    "Republic of Korea": "South Korea",
    "United Arab Emirates": "UAE",
    Czechia: "Czech Republic"
  };
  return aliases[clean] || clean;
}

function renderCountryTag() {
  if (!countryTags) return;
  const country = countryInput.value.trim();
  countryTags.innerHTML = country ? `
    <div class="city-tag country-tag" data-country="${country}">
      ${t("countryNames")[country] || country}
      <button
        class="city-tag-remove"
        data-remove-country="true"
        type="button">×</button>
    </div>
  ` : "";
}

function updateCityAutocompleteRestriction() {
  if (!cityAutocomplete) return;
  if (state.countryCode) {
    cityAutocomplete.setComponentRestrictions({ country: state.countryCode.toLowerCase() });
  } else {
    cityAutocomplete.setComponentRestrictions({ country: [] });
  }
}

function setCountrySelection(countryName, countryCode = "", options = {}) {
  const country = normalizeCountryName(countryName || "");
  if (!country) return;
  countryInput.value = country;
  state.countryCode = countryCode || countryCodeByName[country] || "";
  renderCountryTag();
  updateCityAutocompleteRestriction();
  if (options.clearCities !== false) {
    state.cities = [];
    if (cityAddSelect) cityAddSelect.value = "";
    cityCentersCache = {};
    renderCityTags();
    resetMustVisitsForDestination();
    renderTravelers();
    generateTrip().catch(console.error);
  }
}

function renderCityTags() {
  if (!cityTags) return;

  const fallbackCity = countryInput.value
    ? (countryCities[countryInput.value]?.[0] || destinationInput.value || "Tokyo")
    : "";
  state.cities = [...new Set(state.cities.map((city) => String(city || "").trim()).filter(Boolean))];
  if (!state.cities.length && fallbackCity) state.cities = [fallbackCity];
  if (destinationInput) {
    renderCityOptions(state.cities[0]);
    destinationInput.value = state.cities[0];
  }

  cityTags.innerHTML = state.cities.map((city) => `
    <div class="city-tag" data-city="${city}">
      ${city}
      <button
        class="city-tag-remove"
        data-remove-city="${city}"
        type="button">×</button>
    </div>
  `).join("");

  if (cityAddSelect) {
    cityAddSelect.value = "";
    cityAddSelect.placeholder = state.language === "en" ? "Search any city" : "搜索任意城市";
  }

  renderAccommodationOptions();
}

function rebuildCitiesFromTags() {
  const currentCities = cityTags
    ? [...cityTags.querySelectorAll(".city-tag")]
      .map((tag) => tag.dataset.city)
      .filter(Boolean)
    : [];
  state.cities = currentCities.length ? currentCities : [destinationInput.value].filter(Boolean);
  return state.cities;
}

function extractCityNameFromPlace(place) {
  const components = place?.address_components || [];
  const cityComponent = components.find((component) =>
    component.types?.includes("locality") ||
    component.types?.includes("postal_town") ||
    component.types?.includes("administrative_area_level_2") ||
    component.types?.includes("administrative_area_level_1")
  );
  return (cityComponent?.long_name || place?.name || cityAddSelect?.value || "").trim();
}

function extractCountryFromPlace(place) {
  const component = place?.address_components?.find((item) => item.types?.includes("country"));
  return {
    name: normalizeCountryName(component?.long_name || place?.name || countryInput?.value || ""),
    code: component?.short_name || ""
  };
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "") || "area";
}

function addCityTag(cityName) {
  const city = String(cityName || "").trim();
  if (!city || state.cities.includes(city)) return false;
  state.cities.push(city);
  delete cityCentersCache[city];
  renderCityTags();
  resetMustVisitsForDestination();
  renderTravelers();
  generateTrip().catch(console.error);
  return true;
}

function initCityAutocomplete() {
  if (!cityAddSelect || cityAutocomplete) return;
  if (!window.google?.maps?.places) {
    window.setTimeout(initCityAutocomplete, 600);
    return;
  }
  cityAutocomplete = new google.maps.places.Autocomplete(cityAddSelect, {
    types: ["(cities)"],
    fields: ["address_components", "name", "formatted_address", "geometry"]
  });
  updateCityAutocompleteRestriction();
  cityAutocomplete.addListener("place_changed", () => {
    const city = extractCityNameFromPlace(cityAutocomplete.getPlace());
    if (addCityTag(city)) cityAddSelect.value = "";
  });
}

function initCountryAutocomplete() {
  if (!countryInput || countryAutocomplete) return;
  if (!window.google?.maps?.places) {
    window.setTimeout(initCountryAutocomplete, 600);
    return;
  }
  countryAutocomplete = new google.maps.places.Autocomplete(countryInput, {
    types: ["country"],
    fields: ["address_components", "name", "formatted_address", "geometry"]
  });
  countryAutocomplete.addListener("place_changed", () => {
    const country = extractCountryFromPlace(countryAutocomplete.getPlace());
    setCountrySelection(country.name, country.code);
  });
}

function extractIataCode(text = "") {
  const match = String(text).match(/\(([A-Z]{3})\)\s*$/) || String(text).match(/\b([A-Z]{3})\b/g)?.slice(-1)?.[0];
  return Array.isArray(match) ? match[1] : match || "";
}

function formatAirportDisplay(name = "", code = "") {
  const cleanName = String(name || "").replace(/\s*\([A-Z]{3}\)\s*$/, "").trim();
  return code ? `${cleanName || code} (${code})` : cleanName;
}

function applyAirportSelection(kind, place) {
  const input = kind === "departure" ? departureAirportInput : arrivalAirportInput;
  if (!input) return;
  const location = place?.geometry?.location;
  const rawName = place?.name || place?.formatted_address || input.value || "";
  const code = extractIataCode(rawName);
  const display = formatAirportDisplay(rawName, code);
  const key = code || display || "UNKNOWN";
  const coords = location ? { lat: location.lat(), lng: location.lng(), x: 50, y: 50 } : null;

  input.value = display;
  input.dataset.airportCode = code;
  input.dataset.lat = coords ? String(coords.lat) : "";
  input.dataset.lng = coords ? String(coords.lng) : "";
  if (coords) airportCoords[key] = coords;

  if (kind === "departure") {
    state.departureAirport = key;
    state.departureAirportName = display;
    state.departureAirportCoords = coords;
  } else {
    state.arrivalAirport = key;
    state.arrivalAirportName = display;
    state.arrivalAirportCoords = coords;
  }
  updateFlightTimeVisibility();
  generateTrip().catch(console.error);
}

function clearAirportSelection(kind) {
  const input = kind === "departure" ? departureAirportInput : arrivalAirportInput;
  if (!input) return;
  input.value = "";
  input.dataset.airportCode = "";
  input.dataset.lat = "";
  input.dataset.lng = "";
  if (kind === "departure") {
    state.departureAirport = "UNKNOWN";
    state.departureAirportName = "";
    state.departureAirportCoords = null;
  } else {
    state.arrivalAirport = "UNKNOWN";
    state.arrivalAirportName = "";
    state.arrivalAirportCoords = null;
  }
  updateFlightTimeVisibility();
}

function updateAirportAutocompleteBias() {
  if (arrivalAirportAutocomplete) {
    const center = cityCentersCache[state.cities?.[0]];
    if (center?.lat && center?.lng && window.google?.maps) {
      const latLng = new google.maps.LatLng(center.lat, center.lng);
      const circle = new google.maps.Circle({ center: latLng, radius: 200000 });
      arrivalAirportAutocomplete.setBounds(circle.getBounds());
      arrivalAirportAutocomplete.setOptions({ strictBounds: false });
    }
  }
}

function initAirportAutocomplete() {
  if (!window.google?.maps?.places) {
    window.setTimeout(initAirportAutocomplete, 600);
    return;
  }
  if (departureAirportInput && !departureAirportAutocomplete) {
    departureAirportAutocomplete = new google.maps.places.Autocomplete(departureAirportInput, {
      types: ["airport"],
      fields: ["address_components", "name", "formatted_address", "geometry"]
    });
    departureAirportAutocomplete.addListener("place_changed", () => {
      applyAirportSelection("departure", departureAirportAutocomplete.getPlace());
    });
  }
  if (arrivalAirportInput && !arrivalAirportAutocomplete) {
    arrivalAirportAutocomplete = new google.maps.places.Autocomplete(arrivalAirportInput, {
      types: ["airport"],
      fields: ["address_components", "name", "formatted_address", "geometry"]
    });
    arrivalAirportAutocomplete.addListener("place_changed", () => {
      applyAirportSelection("arrival", arrivalAirportAutocomplete.getPlace());
    });
  }
  updateAirportAutocompleteBias();
}

function inferCountryForCity(city) {
  return Object.entries(countryCities).find(([, cities]) => cities.includes(city))?.[0] || "Japan";
}

function vibeLabel(id) {
  return t("vibeNames")[id] || id;
}

function renderAccommodationOptions(savedAreas = []) {
  const days = Number(daysInput.value || 1);
  const nights = Math.max(0, days - 1);
  hotelAreaAutocompletes.clear();
  hotelAreaList.innerHTML = Array.from({ length: nights }, (_, index) => {
    const saved = savedAreas[index];
    let savedCity = saved?.city || state.cities[0] || "Tokyo";
    if (!state.cities.includes(savedCity)) savedCity = state.cities[0] || "Tokyo";
    const savedAreaId = saved?.areaId || saved?.id || (typeof saved === "string" ? saved : "");
    const savedLabel = saved?.label || saved?.areaName || savedAreaId || `${savedCity} center`;
    const savedLat = saved?.lat || "";
    const savedLng = saved?.lng || "";
    const cityOptions = state.cities
      .map((city) => `
        <option value="${city}" ${city === savedCity ? "selected" : ""}>
          ${city}
        </option>
      `)
      .join("");
    const previousSavedCity = index > 0
      ? (savedAreas[index - 1]?.city || state.cities[0] || "Tokyo")
      : savedCity;
    const isCitySwitch = index > 0 && savedCity !== previousSavedCity;
    const transferMode = saved?.transferMode || state.cityTransferModes[index] || "train";
    return `
      <div class="hotel-day-row" data-day-index="${index}">
        <span class="hotel-day-label"
              style="color:${["#6c5ce7", "#00cec9", "#fd79a8", "#f0a04b", "#a29bfe"][index % 5]}">
          Day ${index + 1}
        </span>
        <select class="hotel-city-select" data-hotel-day="${index}" data-type="city">
          ${cityOptions}
        </select>
        <input
          class="hotel-area-input"
          data-hotel-day="${index}"
          data-type="area"
          data-area-id="${savedAreaId}"
          data-lat="${savedLat}"
          data-lng="${savedLng}"
          value="${savedLabel}"
          placeholder="${state.language === "en" ? "Search hotel area" : "搜索住宿区域"}"
          autocomplete="off" />
        <label class="city-transfer-control" data-transfer-day="${index}" style="${isCitySwitch ? "" : "display:none"}">
          <span>${t("cityTransfer")}</span>
          <select class="city-transfer-select" data-transfer-day="${index}">
            <option value="train" ${transferMode === "train" ? "selected" : ""}>🚄 ${state.language === "en" ? "Train" : "火车"}</option>
            <option value="flight" ${transferMode === "flight" ? "selected" : ""}>✈️ ${state.language === "en" ? "Flight" : "飞机"}</option>
            <option value="bus" ${transferMode === "bus" ? "selected" : ""}>🚌 ${state.language === "en" ? "Bus" : "大巴"}</option>
          </select>
        </label>
      </div>
    `;
  })
    .join("");

  hotelAreaList
    .querySelectorAll(".hotel-city-select")
    .forEach((citySelect) => {
      citySelect.addEventListener("change", () => {
        const dayIndex = Number(citySelect.dataset.hotelDay);
        const newCity = citySelect.value;
        const areaInput = hotelAreaList.querySelector(`.hotel-area-input[data-hotel-day="${dayIndex}"]`);
        if (areaInput) {
          areaInput.value = `${newCity} center`;
          areaInput.dataset.areaId = "center";
          areaInput.dataset.lat = "";
          areaInput.dataset.lng = "";
          initHotelAreaAutocomplete(areaInput);
        }
        updateCityTransferControls();
        generateTrip().catch(console.error);
      });
    });
  hotelAreaList
    .querySelectorAll(".city-transfer-select")
    .forEach((select) => {
      select.addEventListener("change", () => {
        state.cityTransferModes[Number(select.dataset.transferDay)] = select.value;
        generateTrip().catch(console.error);
      });
    });
  hotelAreaList
    .querySelectorAll(".hotel-area-input")
    .forEach((input) => {
      initHotelAreaAutocomplete(input);
      input.addEventListener("change", () => {
        if (!input.value.trim()) {
          input.dataset.areaId = "";
          input.dataset.lat = "";
          input.dataset.lng = "";
        }
        generateTrip().catch(console.error);
      });
    });
  updateCityTransferControls();
}

function initHotelAreaAutocomplete(input) {
  if (!input || hotelAreaAutocompletes.has(input)) return;
  if (!window.google?.maps?.places) {
    window.setTimeout(() => initHotelAreaAutocomplete(input), 600);
    return;
  }
  const options = {
    types: ["neighborhood", "sublocality", "locality"],
    fields: ["address_components", "name", "formatted_address", "geometry"]
  };
  if (state.countryCode) options.componentRestrictions = { country: state.countryCode.toLowerCase() };
  const autocomplete = new google.maps.places.Autocomplete(input, options);
  autocomplete.addListener("place_changed", () => {
    const place = autocomplete.getPlace();
    const dayIndex = Number(input.dataset.hotelDay);
    const citySelect = hotelAreaList.querySelector(`.hotel-city-select[data-hotel-day="${dayIndex}"]`);
    const location = place?.geometry?.location;
    input.value = place?.name || place?.formatted_address || input.value;
    input.dataset.areaId = slugify(input.value || "hotel-area");
    input.dataset.lat = location ? String(location.lat()) : "";
    input.dataset.lng = location ? String(location.lng()) : "";
    const city = extractCityNameFromPlace(place);
    if (city && citySelect && state.cities.includes(city)) citySelect.value = city;
    updateCityTransferControls();
    generateTrip().catch(console.error);
  });
  hotelAreaAutocompletes.set(input, autocomplete);
}

function updateCityTransferControls() {
  const citySelects = [...hotelAreaList.querySelectorAll(".hotel-city-select")];
  hotelAreaList.querySelectorAll(".city-transfer-control").forEach((control) => {
    const index = Number(control.dataset.transferDay);
    const currentCity = citySelects[index]?.value;
    const previousCity = citySelects[index - 1]?.value;
    control.style.display = index > 0 && currentCity && previousCity && currentCity !== previousCity ? "" : "none";
  });
}

function resetMustVisitsForDestination() {
  travelers.forEach((traveler) => {
    traveler.mustVisits = ["", "", ""];
  });
}

function renderTravelers() {
  travelerList.innerHTML = travelers
    .map((traveler, travelerIndex) => {
      const mustVisits = normalizeMustVisits(traveler.mustVisits);
      traveler.mustVisits = mustVisits;
      const isSharedMode = Boolean(sharedTripId);
      const isOwnCard = !isSharedMode || traveler.name === currentSharedMemberName;
      const readonlyAttr = isOwnCard ? "" : "disabled";
      const cardClass = isSharedMode && isOwnCard ? " is-own-member" : isSharedMode ? " is-readonly-member" : "";
      return `
        <article class="traveler-card traveler-editor${cardClass}" data-traveler="${travelerIndex}">
          <div class="avatar" style="--avatar-color: ${traveler.color}">${traveler.name[0]}</div>
          <div>
            <div class="traveler-topline">
              <strong>${traveler.name}</strong>
              <span>${traveler.role}</span>
            </div>
            <div class="mini-vibe-grid">
              ${vibeOptions.map(([id, label]) => `
                <button class="mini-vibe ${traveler.vibes.includes(id) ? "is-selected" : ""}" type="button" data-vibe="${id}" ${readonlyAttr}>
                  ${vibeLabel(id)}
                </button>
              `).join("")}
            </div>
            <div class="must-visit-grid">
              ${mustVisits.map((place, placeIndex) => `
                <label>
                  ${state.language === "zh" ? "想去" : "Want to visit"} ${placeIndex + 1}
                  <div class="nomination-wrap"
                       data-traveler-idx="${travelerIndex}"
                       data-place-idx="${placeIndex}">
                    <input
                      class="nomination-input"
                      data-must-visit="${placeIndex}"
                      value="${place}"
                      placeholder="Search a place..."
                      autocomplete="off"
                      ${readonlyAttr} />
                    <ul class="nomination-suggestions"
                        style="display:none"></ul>
                  </div>
                </label>
              `).join("")}
            </div>
          </div>
        </article>
      `;
    })
    .join("");
  console.log("renderTravelers HTML:", travelerList.innerHTML.slice(0, 500));
}

async function generateTrip(travelerOverride = null) {
  const activeTravelers = Array.isArray(travelerOverride) ? travelerOverride : travelers;
  rebuildCitiesFromTags();
  cityCentersCache = {};
  const destination = state.cities[0] || destinationInput.value;
  if (destinationInput) destinationInput.value = destination;
  const country = countryInput.value;
  const plan = getActivePlan();
  const budgetMax = Number(budgetMaxInput.value || 0);
  const budgetMin = Number(budgetMinInput.value || Math.round(budgetMax * 0.72));
  const days = Number(daysInput.value || 5);
  const hotelStars = Number(hotelStarsInput.value || 3);
  state.arrivalAirport = arrivalAirportInput?.value || state.arrivalAirport || "UNKNOWN";
  state.flightArrivalTime = flightArrivalTimeInput?.value || state.flightArrivalTime || "";
  syncHotelAreaCount(days);
  const hotelAreas = getHotelAreas(plan, days);
  state.cityTransferModes = Object.fromEntries(hotelAreas.map((hotel, index) => [index, hotel.transferMode || "train"]));
  const day1MaxStops = getDay1MaxStops(state.flightArrivalTime);
  const discoveryMode = discoveryModeInput.value === "on";
  const transportMode = transportModeInput.value;
  const groupVibes = [...new Set(activeTravelers.flatMap((traveler) => traveler.vibes))];

  // 获取城市中心坐标
  let cityCenter = null;

  try {
    cityCenter = await getCityCenter(destination, country);
  } catch {}

  const uniqueCities = [...new Set([
    ...state.cities,
    ...hotelAreas.map((hotel) => hotel.city).filter(Boolean)
  ])];
  console.log("hotelAreas cities:", hotelAreas.map((hotel) => ({ city: hotel.city, label: hotel.label })));
  console.log("uniqueCities:", uniqueCities);
  await Promise.all(uniqueCities.map(async (city) => {
    try {
      const res = await fetch(
        `/api/geocode?address=${encodeURIComponent(city + " " + countryInput.value)}`
      );
      const data = await res.json();
      if (data.lat) cityCentersCache[city] = data;
    } catch {}
  }));
  console.log("cityCentersCache built:", cityCentersCache);

  const geocodedHotels = await Promise.all(
    hotelAreas.map(async (hotel) => {
      if (hotel.lat && hotel.lng) return hotel;
      try {
        const englishLabel = hotel.label.replace(/[^\x00-\x7F/]+/g, "").replace(/\/\s*/, "").trim();
        const query = `${englishLabel || hotel.id || hotel.label} ${hotel.city} ${countryInput.value}`;
        const res = await fetch(
          `/api/geocode?address=${encodeURIComponent(query)}`
        );
        const data = await res.json();
        const address = (data.formattedAddress || "").toLowerCase();
        const mismatchedCity = state.cities.some((city) =>
          city !== hotel.city && address.includes((city || "").toLowerCase())
        );
        if (mismatchedCity) return hotel;
        if (data.lat) return { ...hotel, lat: data.lat, lng: data.lng };
      } catch {}
      return hotel;
    })
  );

  // 如果 discoveryMode 开启，从 API 获取系统推荐
  let apiSystemPlaces = [];
  if (discoveryMode) {
    const allCityPlaces = await Promise.all(
      uniqueCities.map(async (city) => {
        try {
          const center = cityCentersCache[city];
          if (!center) return [];
          const places = await fetchSystemPlaces(center, groupVibes, city);
          return places.map((place) => Array.isArray(place) ? [...place.slice(0, 10), city, ...place.slice(11)] : { ...place, city });
        } catch {
          return [];
        }
      })
    );
    apiSystemPlaces = allCityPlaces.flat();
    console.log("system places by city:", apiSystemPlaces.map((place) => place.name + "→" + place.city));
  }

  // 如果有 API 数据，合并进 plan.places
  const normalizedStaticPlaces = plan.places.map((place, index) =>
    Array.isArray(place)
      ? normalizePlace(place, index, "system")
      : place
  );
  const enrichedPlan = apiSystemPlaces.length > 0
    ? { ...plan, places: [...(discoveryMode ? [] : normalizedStaticPlaces), ...apiSystemPlaces.map((place, index) => normalizePlace(place, normalizedStaticPlaces.length + index, "system"))] }
    : { ...plan, places: discoveryMode ? [] : normalizedStaticPlaces };

  const geocodedPlaces = await geocodePlaces(
    enrichedPlan.places,
    cityCenter
  );

  const nominationCityMap = {};
  await Promise.all(
    activeTravelers.flatMap((traveler) => traveler.mustVisits.filter(Boolean))
      .map(async (name) => {
        try {
          const res = await fetch(
            `/api/geocode?address=${encodeURIComponent(
              name + " " + countryInput.value
            )}`
          );
          const data = await res.json();
          if (data.formattedAddress) {
            const addr = (data.formattedAddress || "").toLowerCase();
            for (const city of state.cities) {
              const cityEn = (cityCentersCache[city]?.formattedAddress || city || "").toLowerCase().split(",")[0].trim();
        if (addr.includes((city || "").toLowerCase()) || addr.includes(cityEn)) {
                nominationCityMap[(name || "").toLowerCase()] = city;
                nominationCityMap[normalizeForMatch(name)] = city;
                break;
              }
            }
          }
        } catch {}
      })
  );

  window._nominationCityMap = nominationCityMap;
  console.log("nominationCityMap:", nominationCityMap);

  const prePlan = {
    ...enrichedPlan,
    places: geocodedPlaces
  };

  const roadmap = await generateRoadmap({
    plan: prePlan,
    travelers: activeTravelers,
    groupVibes,
    budgetMin,
    budgetMax,
    days,
    hotelAreas: geocodedHotels,
    discoveryMode,
    transportMode,
    hotelStars,
    nominationCityMap,
    day1MaxStops,
    geocodedPlaces
  });

  state.latestTrip = { destination, country, cities: state.cities, plan: prePlan, hotelAreas: geocodedHotels, budgetMin, budgetMax, days, discoveryMode, transportMode, hotelStars, groupVibes, cityCenter, arrivalAirport: state.arrivalAirport, flightArrivalTime: state.flightArrivalTime, cityTransferModes: state.cityTransferModes, day1MaxStops, ...roadmap };
  state.activeIndex = 0;
  if (state.latestTrip) {
    const geocodedCandidates = await geocodePlaces(
      state.latestTrip.allCandidates || [],
      state.latestTrip.cityCenter
    );
    state.latestTrip.allCandidates = geocodedCandidates;
    const geocoded = state.latestTrip.places.map((place) =>
      geocodedCandidates.find((candidate) => candidate.id === place.id) || place
    );
    state.latestTrip.places = geocoded;
    state.latestTrip.itineraryDays =
      state.latestTrip.itineraryDays.map((day) => ({
        ...day,
        places: day.places.map((place) =>
          geocoded.find((geocodedPlace) => geocodedPlace.id === place.id) || place
        )
      }));
    const enrichedCandidates = await enrichPlacePhotos(state.latestTrip.allCandidates || []);
    state.latestTrip.allCandidates = enrichedCandidates;
    const enriched = state.latestTrip.places.map((place) =>
      enrichedCandidates.find((candidate) => candidate.id === place.id) || place
    );
    state.latestTrip.places = enriched;
    state.latestTrip.itineraryDays =
      state.latestTrip.itineraryDays.map((day) => ({
        ...day,
        places: day.places.map((place) =>
          enriched.find((enrichedPlace) => enrichedPlace.id === place.id) || place
        )
      }));
  }
  await persistGeneratedItinerary();
  renderTrip();
  enrichTaxiLabels(state.latestTrip)
    .then(() => {
      if (state.latestTrip) {
        renderTrip();
        persistGeneratedItinerary().catch(console.error);
      }
    })
    .catch(console.error);
}

function getActivePlan() {
  const city = destinationInput.value || state.cities?.[0] || "";
  const country = countryInput.value || "";
  return {
    label: `${city}, ${country}`,
    center: `${city} center`,
    visaDays: getVisaDays(country),
    areas: [],
    places: []
  };
}

function getVisaDays(country) {
  const visaMap = {
    France: 18, FR: 18,
    Japan: 12, JP: 12,
    UK: 15, GB: 15,
    USA: 30, US: 30,
    Germany: 18, DE: 18,
    Italy: 18, IT: 18,
    Australia: 20, AU: 20,
    Thailand: 7, TH: 7,
    Singapore: 5, SG: 5,
    "South Korea": 10, KR: 10
  };
  return visaMap[country] || 14;
}

function syncHotelAreaCount(days) {
  const nights = Math.max(0, Number(days || 1) - 1);
  const current = Array.from({ length: nights }, (_, index) => {
    const city = hotelAreaList.querySelector(`.hotel-city-select[data-hotel-day="${index}"]`)?.value;
    const areaInput = hotelAreaList.querySelector(`.hotel-area-input[data-hotel-day="${index}"]`);
    const transferMode = hotelAreaList.querySelector(`.city-transfer-select[data-transfer-day="${index}"]`)?.value;
    return city || areaInput?.value ? {
      city,
      id: areaInput?.dataset.areaId || slugify(areaInput?.value || city),
      label: areaInput?.value || `${city} center`,
      lat: Number(areaInput?.dataset.lat) || null,
      lng: Number(areaInput?.dataset.lng) || null,
      transferMode
    } : null;
  }).filter(Boolean);
  if (current.length !== nights) renderAccommodationOptions(current);
}

function getHotelAreas(plan, days) {
  void plan;
  const citySelects = [...hotelAreaList.querySelectorAll(".hotel-city-select")];
  const areaInputs = [...hotelAreaList.querySelectorAll(".hotel-area-input")];
  const nights = Math.max(0, days - 1);
  return Array.from({ length: nights }, (_, index) => {
    const city = citySelects[index]?.value || state.cities[0] || "Tokyo";
    const areaInput = areaInputs[index];
    const label = areaInput?.value?.trim() || `${city} center`;
    return {
      id: areaInput?.dataset.areaId || slugify(label),
      label,
      x: 50,
      y: 50,
      lat: Number(areaInput?.dataset.lat) || null,
      lng: Number(areaInput?.dataset.lng) || null,
      city
    };
  }).map((hotel, index) => ({
    ...hotel,
    transferMode: index > 0
      ? (hotelAreaList.querySelector(`.city-transfer-select[data-transfer-day="${index}"]`)?.value || state.cityTransferModes[index] || "train")
      : ""
  }));
}

async function geocodePlaces(places, cityCenter) {
  void cityCenter;
  return Promise.all(places.map(async (place) => {
    if (place.lat && place.lng) return assignCityToPlace({
      ...place,
      district: place.district || extractDistrictFromAddress(place.formattedAddress, state.cities)
    });
    try {
      const res = await fetch(
        `/api/geocode?address=${encodeURIComponent(place.searchQuery || (place.name + " " + countryInput.value))}`
      );
      const data = await res.json();
      if (data.lat) {
        const formattedAddress = data.formattedAddress || place.formattedAddress || "";
        return assignCityToPlace({
          ...place,
          lat: data.lat,
          lng: data.lng,
          formattedAddress,
          district: extractDistrictFromAddress(formattedAddress, state.cities)
        });
      }
    } catch {}
    return place;
  }));
}

async function assignCityToPlace(place) {
  if (!place.lat || !place.lng) return place;

  const cities = state.cities || ["Tokyo"];
  const district = place.district || extractDistrictFromAddress(place.formattedAddress, cities);
  if (cities.length === 1) {
    return { ...place, city: cities[0], district };
  }

  if (place.formattedAddress) {
    const addr = (place.formattedAddress || "").toLowerCase();
    for (const city of cities) {
      const cityEn = (cityCentersCache[city]?.formattedAddress || city || "").toLowerCase().split(",")[0].trim();
        if (addr.includes((city || "").toLowerCase()) || addr.includes(cityEn)) {
        console.log("assignCity by address:", place.name, "→", city);
        return { ...place, city, district };
      }
    }
  }

  if (place.city) return { ...place, district };


  try {
    const res = await fetch(
      `/api/geocode?address=${encodeURIComponent(place.name + " " + countryInput.value)}`
    );
    const data = await res.json();
    if (data.formattedAddress) {
      const addr = (data.formattedAddress || "").toLowerCase();
      for (const city of cities) {
        const cityEn = (cityCentersCache[city]?.formattedAddress || city || "").toLowerCase().split(",")[0].trim();
        if (addr.includes((city || "").toLowerCase()) || addr.includes(cityEn)) {
          console.log("assignCity by geocode:", place.name, "→", city, "address:", data.formattedAddress);
          return {
            ...place,
            city,
            lat: data.lat || place.lat,
            lng: data.lng || place.lng,
            formattedAddress: data.formattedAddress,
            district: extractDistrictFromAddress(data.formattedAddress, cities)
          };
        }
      }
    }
  } catch {}

  let nearestCity = cities[0];
  let minDist = Infinity;
  Object.entries(cityCentersCache).forEach(([city, center]) => {
    if (!center?.lat) return;
    const d = Math.sqrt(
      (place.lat - center.lat) ** 2 +
      (place.lng - center.lng) ** 2
    );
    if (d < minDist) {
      minDist = d;
      nearestCity = city;
    }
  });

  console.log("assignCity by distance:", place.name, "→", nearestCity);
  return { ...place, city: nearestCity, district };
}

function extractDistrictFromAddress(formattedAddress = "", cities = []) {
  const parts = String(formattedAddress)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return "";

  const cityNames = new Set((cities || []).map((city) => (city || "").toLowerCase()));
  const countryNames = new Set(Object.keys(countryCities).map((country) => country.toLowerCase()));
  const candidate = parts.find((part) => {
    const lower = part.toLowerCase();
    if (cityNames.has(lower) || countryNames.has(lower)) return false;
    if (/^\d{3,}[-\d\s]*/.test(lower)) return false;
    if (lower.includes("japan") || lower.includes("united states") || lower.includes("france")) return false;
    return true;
  }) || parts[0];

  return candidate
    .replace(/^\d+\s*/, "")
    .replace(/^\d+[-\s]chome[-\s]*/i, "")
    .trim();
}

async function enrichPlacePhotos(places) {
  return Promise.all(places.map(async (place) => {
    if (place.image &&
        !place.image.includes("unsplash.com") &&
        !place.image.includes("placeholder")) {
      return place;
    }

    try {
      const res = await fetch(
        `/api/places?type=nomination` +
        `&query=${encodeURIComponent(place.name)}` +
        (place.lat ? `&lat=${place.lat}&lng=${place.lng}` : "")
      );
      const data = await res.json();
      const match = data.places?.[0];
      const photoName = match?.photos?.[0]?.name;
      const editorialSummary = match?.editorialSummary?.text || place.editorialSummary || "";

      if (photoName) {
        return {
          ...place,
          image: `/api/photo?name=${encodeURIComponent(photoName)}`,
          editorialSummary
        };
      }
      if (editorialSummary) return { ...place, editorialSummary };
    } catch {}
    return place;
  }));
}

async function generateRoadmap({ plan, travelers, groupVibes, budgetMin, budgetMax, days, hotelAreas, discoveryMode, transportMode, hotelStars, nominationCityMap = {}, day1MaxStops = 3, geocodedPlaces = [] }) {
  const travelerCount = Number(travelerCountInput?.value || 4);
  const roomsNeeded = Math.ceil(travelerCount / 2);
  const country = countryInput.value;
  const hotelRates = hotelCostByCountry[country] || hotelCostByCountry.default;
  const hotelCostPerNight = (hotelRates[hotelStars] || hotelRates[3]) * roomsNeeded;
  const hotelCostPerPersonPerNight = Math.round(hotelCostPerNight / travelerCount);
  const totalBudgetCap = budgetMax;
  const hotelTotalCost = hotelCostPerPersonPerNight * Math.max(0, days - 1);
  const activityBudgetCap = Math.max(0, totalBudgetCap - hotelTotalCost);
  const activityBudgetPerDay = Math.round(activityBudgetCap / Math.max(1, days));
  const activityBudgetTotal = activityBudgetCap;
  const BUDGET_FLEX = 1.15;
  const hardCap = activityBudgetCap * BUDGET_FLEX;
  const targetCount = Math.min(15, Math.max(days * 2, days * 3));
  const planCity = plan.city || (state.cities && state.cities[0]) || "";
  const systemPlaces = discoveryMode ? geocodedPlaces.filter(p => p.source === "system") : plan.places.map((place, index) => {
    const p = normalizePlace(place, index, "system");
    return p.city ? p : { ...p, city: planCity };
  });
  const nominatedPlaces = buildNominatedCandidates(travelers, systemPlaces, hotelAreas[0], hotelAreas);
  const nominatedWithCity = nominatedPlaces.map((place) => {
    const nameKey = normalizeForMatch(place.name);
    const fuzzyMatchKey = Object.keys(nominationCityMap).find((key) =>
      nameKey.includes(key) || key.includes(nameKey)
    );
    const city = nominationCityMap[nameKey] ||
                 nominationCityMap[(place.name || "").toLowerCase()] ||
                 (fuzzyMatchKey && nominationCityMap[fuzzyMatchKey]) ||
                 place.city ||
                 "";
    return { ...place, city };
  });
  const pool = buildCandidatePool({ nominatedPlaces: nominatedWithCity, systemPlaces, discoveryMode });
  const poolWithCity = pool.map((place) => {
    if (place.city) return place;
    const matched = plan.places.find((candidate) => normalizeText(candidate.name) === normalizeText(place.name));
    return matched?.city
      ? { ...place, city: matched.city }
      : place;
  });
  const geocodedPool = await geocodePlaces(poolWithCity, null);
  const candidates = geocodedPool.map((place) => scoreCandidate(place, travelers, groupVibes, activityBudgetPerDay, hotelAreas));
  const shortList = diversifyCandidates(candidates, targetCount, discoveryMode, days);
  const shortListKeys = new Set(shortList.map((place) => place.id));
  const budgetReservePool = candidates
    .filter((place) => !shortListKeys.has(place.id))
    .sort((a, b) => b.score - a.score);
  const budgetResult = repairBudget(shortList, targetCount, hardCap, days, transportMode, budgetReservePool);
  const keptKeys = new Set(budgetResult.kept.map((place) => place.id));
  const removedKeys = new Set(budgetResult.removed.map((place) => place.id));
  const reservePool = candidates
    .filter((place) => !keptKeys.has(place.id) && !removedKeys.has(place.id) && !shortListKeys.has(place.id))
    .sort((a, b) => b.score - a.score);
  const clusteredDays = rebalanceDayClusters(clusterDays(budgetResult.kept, hotelAreas, days, transportMode, day1MaxStops), days, reservePool, hotelAreas, transportMode, candidates);
  const itineraryDays = await buildDayRoutes(clusteredDays, hotelAreas, transportMode, reservePool, candidates);
  const orderedPlaces = itineraryDays.flatMap((day) => day.places);
  const legs = itineraryDays.flatMap((day) => day.legs);
  const routeCost = itineraryDays.reduce((sum, day) => sum + day.routeCost, 0);
  const hotelCost = hotelCostPerPersonPerNight * Math.max(0, days - 1);
  const activityCost = orderedPlaces.reduce((sum, place) => sum + place.cost, 0) + days * 115 + routeCost;
  const total = activityCost + hotelCost;
  const averageScore = Math.round(orderedPlaces.reduce((sum, place) => sum + place.score, 0) / orderedPlaces.length);

  return {
    itineraryDays,
    places: orderedPlaces,
    allCandidates: candidates,
    legs,
    total,
    routeCost,
    algorithm: {
      candidateCount: candidates.length,
      nominatedCount: nominatedWithCity.length,
      reserveCount: reservePool.length,
      substituteCount: orderedPlaces.filter((place) => place.isSubstitute).length,
      systemCount: orderedPlaces.filter((place) => place.source === "system").length,
      discoveryMode,
      transportMode,
      maxTravelMin: getDynamicMaxTravel(transportMode, candidates),
      selectedCount: orderedPlaces.length,
      averageScore,
      budgetAction: formatBudgetAction(total, budgetMin, totalBudgetCap),
      routeMinutes: legs.reduce((sum, leg) => sum + leg.minutes, 0)
    },
    costBreakdown: { hotelCost, activityCost, hotelCostPerNight, hotelCostPerPersonPerNight, activityBudgetPerDay, activityBudgetTotal, travelerCount, roomsNeeded }
  };
}

function normalizePlace(place, index, source = "system") {
  if (!Array.isArray(place)) {
    return {
      ...place,
      id: place.id || `${source}-${normalizeText(place.name)}`,
      index: place.index ?? index,
      source: place.source || source,
      district: place.district || extractDistrictFromAddress(place.formattedAddress, state.cities),
      editorialSummary: place.editorialSummary || "",
      googlePlaceId: place.googlePlaceId || place.placeId || "",
      userRatingCount: place.userRatingCount || 0,
      nominations: place.nominations || []
    };
  }
  return {
    name: place[0],
    id: `${source}-${normalizeText(place[0])}`,
    vibe: place[1],
    x: place[2],
    y: place[3],
    cost: place[4],
    defaultRoute: place[5],
    description: place[6],
    formattedAddress: place[6] || "",
    district: extractDistrictFromAddress(place[6] || "", state.cities),
    image: place[7],
    lat: place[8] || null,
    lng: place[9] || null,
    city: place[10] || place.city || "",
    editorialSummary: place[11] || "",
    googlePlaceId: place[12] || "",
    userRatingCount: place[13] || 0,
    index,
    source,
    nominations: []
  };
}

function buildNominatedCandidates(travelers, basePlaces, accommodation, hotelAreas = []) {
  const byName = new Map(basePlaces.map((place) => [normalizeForMatch(place.name), place]));
  const nominations = new Map();

  travelers.forEach((traveler, travelerIndex) => {
    traveler.mustVisits
      .map((place) => place.trim())
      .filter(Boolean)
      .forEach((name, placeIndex) => {
        const rank = placeIndex + 1;
        const matched = byName.get(normalizeForMatch(name));
        if (matched) {
          const key = normalizeForMatch(matched.name);
          if (!nominations.has(key)) nominations.set(key, { ...matched, city: matched.city || hotelAreas[0]?.city || state.cities[0] || "", source: "nominated", nominations: [] });
          nominations.get(key).nominations.push({ member: traveler.name, rank });
          return;
        }

        const hash = hashString(`${traveler.name}-${name}-${placeIndex}`);
        const angle = (hash % 360) * Math.PI / 180;
        const radius = 14 + (hash % 24);
        const key = normalizeForMatch(name);
        if (!nominations.has(key)) {
          nominations.set(key, {
          name,
          id: `nominated-${key}`,
          vibe: traveler.vibes[placeIndex % traveler.vibes.length] || "hidden",
          x: clamp(Math.round(accommodation.x + Math.cos(angle) * radius), 18, 82),
          y: clamp(Math.round(accommodation.y + Math.sin(angle) * radius), 18, 82),
          cost: 36 + (hash % 45),
          defaultRoute: "待计算",
          description: `${traveler.name} 标记的必去点，路线会围绕住宿区域自动插入。`,
          searchQuery: `${name} ${countryInput.value}`,
          image: "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=82",
          index: 100 + travelerIndex * 10 + placeIndex,
          city: hotelAreas[0]?.city || state.cities[0] || "",
            source: "nominated",
            nominations: [],
          isSynthetic: true
          });
        }
        nominations.get(key).nominations.push({ member: traveler.name, rank });
      });
  });

  return [...nominations.values()];
}

function buildCandidatePool({ nominatedPlaces, systemPlaces, discoveryMode }) {
  const nominatedKeys = new Set(nominatedPlaces.map((place) => normalizeForMatch(place.name)));
  const systemOnly = systemPlaces.filter((place) => !nominatedKeys.has(normalizeForMatch(place.name)));

  if (!discoveryMode) {
    return nominatedPlaces.length >= minimumCandidatePool
      ? nominatedPlaces
      : [...nominatedPlaces, ...systemOnly.slice(0, minimumCandidatePool - nominatedPlaces.length)];
  }

  return [...nominatedPlaces, ...systemOnly];
}

function scoreCandidate(place, travelers, groupVibes, budgetMax, hotelAreas = []) {
  const supporters = travelers.filter((traveler) => traveler.vibes.includes(place.vibe));
  const nominationScore = place.nominations.length
    ? Math.max(...place.nominations.map((nomination) => rankWeights[nomination.rank] || 0))
    : 0;
  const groupConsensus = (supporters.length / travelers.length) * 100;
  const budgetFit = Math.max(0, 100 - (place.cost / Math.max(1, budgetMax)) * 100);
  const candidateHotels = hotelAreas.filter((hotel) => !place.city || !hotel.city || hotel.city === place.city);
  const referenceHotels = candidateHotels.length ? candidateHotels : hotelAreas;
  const referenceHotel = referenceHotels
    .map((hotel) => ({ hotel, dist: travelTimeBetween(hotel, place, "TRANSIT") }))
    .sort((a, b) => a.dist - b.dist)[0]?.hotel;
  const routeMinutes = referenceHotel ? travelTimeBetween(referenceHotel, place, "TRANSIT") : 0;
  const routeEfficiency = Math.max(0, 100 - routeMinutes * 1.6);
  const score = Math.round(
    nominationScore * algorithmWeights.nominationScore +
    groupConsensus * algorithmWeights.groupConsensus +
    budgetFit * algorithmWeights.budgetFit +
    routeEfficiency * algorithmWeights.routeEfficiency
  );

  return {
    ...place,
    supporters,
    nominationScore: Math.round(nominationScore),
    groupConsensus: Math.round(groupConsensus),
    routeEfficiency: Math.round(routeEfficiency),
    consensus: Math.min(98, Math.round(50 + groupConsensus * 0.28 + nominationScore * 0.2)),
    score,
    rationale: buildRationale(place.nominations, supporters, budgetFit)
  };
}

function buildRationale(nominations, supporters, budgetFit) {
  const reasons = [];
  if (nominations.length) reasons.push(state.language === "en"
    ? `${nominations.map((item) => `${item.member} #${item.rank}`).join(", ")} nominated`
    : `${nominations.map((item) => `${item.member} #${item.rank}`).join("、")} 提名`);
  if (supporters.length) reasons.push(state.language === "en"
    ? `${supporters.map((traveler) => traveler.name).join(", ")} match`
    : `${supporters.map((traveler) => traveler.name).join("、")} 匹配`);
  reasons.push(state.language === "en"
    ? (budgetFit > 72 ? "budget friendly" : "high-cost anchor")
    : (budgetFit > 72 ? "预算友好" : "高消费锚点"));
  return reasons.join(" · ");
}

function diversifyCandidates(candidates, count, discoveryMode, days) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.cost - b.cost);
  const maxPerVibe = getMaxPerVibe(days);
  const buckets = new Map();

  for (const candidate of sorted) {
    const cityVibeKey = `${candidate.city || "unknown"}:${candidate.vibe}`;
    if (!buckets.has(cityVibeKey)) buckets.set(cityVibeKey, []);
    buckets.get(cityVibeKey).push(candidate);
  }

  const vibeCapped = [...buckets.values()]
    .flatMap((bucket) => {
      const nominated = bucket
        .filter((candidate) => candidate.source === "nominated")
        .sort((a, b) => b.score - a.score || a.cost - b.cost);
      const system = bucket
        .filter((candidate) => candidate.source !== "nominated")
        .sort((a, b) => b.score - a.score || a.cost - b.cost);
      const chosenNominated = nominated.slice(0, maxPerVibe);
      return [
        ...chosenNominated,
        ...system.slice(0, Math.max(0, maxPerVibe - chosenNominated.length))
      ];
    })
    .sort((a, b) => b.score - a.score || a.cost - b.cost)
    .slice(0, count);
  if (vibeCapped.length >= count) return vibeCapped;

  const selectedIds = new Set(vibeCapped.map((candidate) => candidate.id));
  const fillUp = sorted
    .filter((candidate) => !selectedIds.has(candidate.id))
    .slice(0, count - vibeCapped.length);
  return [...vibeCapped, ...fillUp]
    .sort((a, b) => b.score - a.score || a.cost - b.cost)
    .slice(0, count);
}

function repairBudget(candidates, targetCount, budgetMax, days, transportMode = "TRANSIT", reservePool = []) {
  let repaired = candidates.slice(0, targetCount);
  const removed = [];
  let total = estimateTotal(repaired, days, transportMode);
  const totalBudgetCap = budgetMax;
  const totalFloor = budgetMax * 0.70;
  const minStops = days * 2;

  while (total > totalBudgetCap && repaired.length > minStops) {
    const removal = repaired
      .map((place, index) => ({ index, penalty: place.cost / Math.max(1, place.score) }))
      .sort((a, b) => b.penalty - a.penalty)[0];
    removed.push(repaired.splice(removal.index, 1)[0]);
    total = estimateTotal(repaired, days, transportMode);
  }

  if (total < totalFloor) {
    const keptIds = new Set(repaired.map((place) => place.id));
    const sortedReservePool = [...reservePool].sort((a, b) => b.score - a.score);

    for (const candidate of sortedReservePool) {
      if (total >= totalFloor) break;
      if (keptIds.has(candidate.id)) continue;

      const nextTotal = estimateTotal([...repaired, candidate], days, transportMode);
      if (nextTotal > totalBudgetCap) continue;

      repaired.push(candidate);
      keptIds.add(candidate.id);
      total = nextTotal;
    }
  }

  return { kept: repaired, removed };
}

function clusterDays(places, hotelAreas, days, transportMode = "TRANSIT", day1MaxStops = 3) {
  console.log("clusterDays places with city:", places.map((place) => ({ name: place.name, city: place.city })));
  const k = days;
  const clusters = Array.from({ length: k }, () => []);
  const dayIndicesByCity = new Map();
  const flightDayIndex = state.flightDepartureTime ? days - 1 : null;
  const maxStopsPerDay = 3;
  const fillThreshold = getDynamicMaxTravel(transportMode, places);
  const getDayHotel = (index) => hotelAreas[index] || hotelAreas[index - 1] || hotelAreas[0];
  const isCitySwitchDay = (index) => index > 0 &&
    getDayHotel(index)?.city &&
    getDayHotel(index - 1)?.city &&
    getDayHotel(index).city !== getDayHotel(index - 1).city;
  const getDayStopCap = (index) => {
    if (index === 0) return day1MaxStops;
    if (isCitySwitchDay(index)) {
      const mode = getDayHotel(index)?.transferMode || state.cityTransferModes[index] || "train";
      return cityTransferMaxStops[mode] || 2;
    }
    return maxStopsPerDay;
  };
  const placeToHotelDistance = (place, hotel) =>
    (place.lat && place.lng && hotel?.lat && hotel?.lng)
      ? Math.hypot(place.lat - hotel.lat, place.lng - hotel.lng)
      : distance(place, hotel || { x: 50, y: 50 });

  Array.from({ length: k }, (_, index) => {
    if (index === flightDayIndex) return;
    if (getDayStopCap(index) <= 0) return;
    const hotel = getDayHotel(index);
    if (!hotel) return;
    const city = hotel.city || "unknown";
    if (!dayIndicesByCity.has(city)) dayIndicesByCity.set(city, []);
    dayIndicesByCity.get(city).push(index);
  });

  const placesByCity = new Map();
  places.forEach((place) => {
    const city = place.city && dayIndicesByCity.has(place.city)
      ? place.city
      : "";
    if (!city) return;
    if (!placesByCity.has(city)) placesByCity.set(city, []);
    placesByCity.get(city).push(place);
  });

  const assignRoundRobinByCity = (cityPlaces, dayIndices) => {
    const assignOnePass = (sourcePlaces) => {
      const unassignedCityPlaces = sourcePlaces
      .slice()
      .sort((a, b) => b.score - a.score);
      let assignedThisRound = true;

      while (assignedThisRound) {
        assignedThisRound = false;
        const availableDays = dayIndices
          .filter((index) => index !== flightDayIndex && clusters[index].length < getDayStopCap(index))
          .sort((a, b) => clusters[a].length - clusters[b].length || a - b);

        for (const dayIndex of availableDays) {
          if (clusters[dayIndex].length >= getDayStopCap(dayIndex)) continue;
          const dayHotel = getDayHotel(dayIndex);
          const dayCity = dayHotel?.city || "";
          if (!dayHotel || !dayCity) continue;
          const candidateIndex = unassignedCityPlaces.findIndex((place) =>
            place.city === dayCity &&
            travelTimeBetween(dayHotel, place, transportMode) <= fillThreshold
          );
          if (candidateIndex === -1) continue;
          const [candidate] = unassignedCityPlaces.splice(candidateIndex, 1);
          clusters[dayIndex].push(candidate);
          assignedThisRound = true;
        }
      }
    };

    const nominatedPlaces = cityPlaces.filter((place) => (place.nominations || []).length > 0);
    const systemPlaces = cityPlaces.filter((place) => !(place.nominations || []).length);
    assignOnePass(nominatedPlaces);
    assignOnePass(systemPlaces);
  };

  placesByCity.forEach((cityPlaces, city) => {
    const dayIndices = dayIndicesByCity.get(city) || [];
    if (!dayIndices.length) return;

    const sortedPlaces = cityPlaces
      .slice()
      .sort((a, b) => b.score - a.score);

    assignRoundRobinByCity(sortedPlaces, dayIndices);
  });

  const unassigned = [];
  if (flightDayIndex !== null && clusters[flightDayIndex]?.length) {
    unassigned.push(...clusters[flightDayIndex]);
    clusters[flightDayIndex] = [];
  }

  const assignedIds = new Set(clusters.flatMap((cluster) => cluster.map((place) => place.id)));
  places.forEach((place) => {
    if (!assignedIds.has(place.id) && !unassigned.some((candidate) => candidate.id === place.id)) {
      unassigned.push(place);
    }
  });

  clusters.forEach((cluster, index) => {
    if (index === flightDayIndex || cluster.length) return;
    if (getDayStopCap(index) <= 0) return;
    const dayHotel = getDayHotel(index);
    const dayCity = dayHotel?.city || "";
    const sameCityCandidates = unassigned
      .map((place, reserveIndex) => ({ place, reserveIndex }))
      .filter(({ place }) => {
        if (dayCity) return place.city === dayCity;
        return true;
      });
    const nominatedCandidate = sameCityCandidates
      .filter(({ place }) => (place.nominations || []).length > 0)
      .sort((a, b) => b.place.score - a.place.score)[0];
    const fallbackCandidate = sameCityCandidates
      .sort((a, b) => b.place.score - a.place.score)[0]?.reserveIndex;
    const candidateIndex = nominatedCandidate?.reserveIndex ?? fallbackCandidate;

    if (candidateIndex === undefined) return;
    const [candidate] = unassigned.splice(candidateIndex, 1);
    cluster.push(candidate);
    assignedIds.add(candidate.id);
  });

  clusters.forEach((cluster, index) => {
    if (index === flightDayIndex) return;
    const stopCap = getDayStopCap(index);
    if (stopCap <= 0) return;
    const dayHotel = getDayHotel(index);
    const dayCity = dayHotel?.city || "";
    if (!dayHotel || !dayCity) return;

    while (cluster.length < Math.min(2, stopCap)) {
      const candidateIndex = unassigned
        .map((place, reserveIndex) => ({
          place,
          reserveIndex,
          minutes: travelTimeBetween(dayHotel, place, transportMode)
        }))
        .filter(({ place, minutes }) =>
          place.city === dayCity &&
          minutes <= fillThreshold &&
          !assignedIds.has(place.id)
        )
        .sort((a, b) => b.place.score - a.place.score || a.minutes - b.minutes)[0]?.reserveIndex;

      if (candidateIndex === undefined) break;
      const [candidate] = unassigned.splice(candidateIndex, 1);
      cluster.push(candidate);
      assignedIds.add(candidate.id);
    }
  });

  const centroids = clusters.map((cluster, index) => {
    const hotel = getDayHotel(index) || { x: 50, y: 50 };
    if (!cluster.length) return { x: hotel.x, y: hotel.y };
    const mean = {
      x: cluster.reduce((sum, place) => sum + place.x, 0) / cluster.length,
      y: cluster.reduce((sum, place) => sum + place.y, 0) / cluster.length
    };
    return {
      x: hotel.x * 0.3 + mean.x * 0.7,
      y: hotel.y * 0.3 + mean.y * 0.7
    };
  });

  return clusters.map((placesForDay, index) => ({
    index,
    places: placesForDay,
    centroid: centroids[index],
    hotel: getDayHotel(index),
    maxStops: getDayStopCap(index),
    isLateArrivalDay: index === 0 && day1MaxStops === 0,
    isCityTransferDay: isCitySwitchDay(index),
    transferMode: isCitySwitchDay(index) ? (getDayHotel(index)?.transferMode || state.cityTransferModes[index] || "train") : ""
  }));
}

function rebalanceDayClusters(dayClusters, days, reservePool = [], hotelAreas = [], transportMode = "TRANSIT", travelPool = []) {
  const totalPlaces = dayClusters.reduce((sum, day) => sum + day.places.length, 0);
  const targetPerDay = Math.ceil(totalPlaces / Math.max(1, days));
  const assignedIds = new Set(dayClusters.flatMap((day) => day.places.map((place) => place.id)));
  const flightDayIndex = state.flightDepartureTime ? days - 1 : null;
  let moved = true;

  while (moved && dayClusters.some((day) => day.places.length > Math.min(day.maxStops ?? 3, targetPerDay + 1))) {
    moved = false;
    for (const day of dayClusters.filter((cluster) => cluster.index !== flightDayIndex && cluster.places.length > Math.min(cluster.maxStops ?? 3, targetPerDay + 1))) {
      const underloaded = dayClusters.filter((cluster) => cluster.index !== flightDayIndex && cluster.places.length < Math.min(cluster.maxStops ?? 3, targetPerDay));
      if (!underloaded.length) continue;
      const move = day.places
        .slice()
        .sort((a, b) => a.score - b.score)
        .map((place, placeIndex) => {
          const originalIndex = day.places.indexOf(place);
          const target = underloaded
            .filter((cluster) => dayAccepts(
              place,
              cluster.places,
              hotelAreas[cluster.index] || cluster.hotel,
              transportMode,
              hotelAreas[Math.max(0, cluster.index - 1)] || hotelAreas[cluster.index] || cluster.hotel,
              travelPool
            ))
            .map((cluster) => ({ cluster, dist: distance(place, cluster.centroid) }))
            .sort((a, b) => a.dist - b.dist)[0];
          return target ? { place, placeIndex: originalIndex, target: target.cluster, dist: target.dist } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.dist - b.dist)[0];

      if (move) {
        day.places.splice(move.placeIndex, 1);
        move.target.places.push(move.place);
        moved = true;
        continue;
      }

      const weakest = day.places
        .map((place, index) => ({ place, index }))
        .sort((a, b) => a.place.score - b.place.score)[0];
      if (!weakest) continue;
      const [dropped] = day.places.splice(weakest.index, 1);
      assignedIds.delete(dropped.id);
      const substituteIndex = reservePool.findIndex((place) => !assignedIds.has(place.id) && dayAccepts(
        place,
        day.places,
        hotelAreas[day.index] || day.hotel,
        transportMode,
        getDayStartPoint(hotelAreas, day.index, hotelAreas[day.index] || day.hotel),
        travelPool
      ));
      if (substituteIndex >= 0) {
        const substitute = { ...reservePool.splice(substituteIndex, 1)[0], isSubstitute: true };
        day.places.push(substitute);
        assignedIds.add(substitute.id);
      }
      moved = true;
    }
  }

  for (const day of dayClusters) {
    if (day.index === flightDayIndex) continue;
    if ((day.maxStops ?? 3) <= 0) continue;
    const dayHotel = hotelAreas[day.index] || day.hotel;
    const startPoint = getDayStartPoint(hotelAreas, day.index, dayHotel);

    while (day.places.length < Math.min(2, day.maxStops ?? 3)) {
      const reserveIndex = reservePool
        .map((place, index) => ({ place, index }))
        .filter(({ place }) =>
          !assignedIds.has(place.id) &&
          (place.nominations || []).length > 0 &&
          (!dayHotel?.city || place.city === dayHotel.city) &&
          dayAccepts(place, day.places, dayHotel, transportMode, startPoint, travelPool)
        )
        .sort((a, b) => b.place.score - a.place.score)[0]?.index;

      if (reserveIndex === undefined) break;
      const [candidate] = reservePool.splice(reserveIndex, 1);
      day.places.push(candidate);
      assignedIds.add(candidate.id);
    }
  }

  for (const day of dayClusters) {
    if (day.index === flightDayIndex) {
      day.places = [];
      continue;
    }
    const dayHotel = hotelAreas[day.index] || day.hotel;
    const startPoint = getDayStartPoint(hotelAreas, day.index, dayHotel);
    while (day.places.length && !routeLegsWithinThreshold(day.places, startPoint, transportMode, travelPool)) {
      const weakest = day.places
        .map((place, index) => ({ place, index }))
        .sort((a, b) => a.place.score - b.place.score)[0];
      if (!weakest) break;
      const [dropped] = day.places.splice(weakest.index, 1);
      assignedIds.delete(dropped.id);
      const substituteIndex = reservePool.findIndex((place) => !assignedIds.has(place.id) && dayAccepts(place, day.places, dayHotel, transportMode, startPoint, travelPool));
      if (substituteIndex >= 0) {
        const substitute = { ...reservePool.splice(substituteIndex, 1)[0], isSubstitute: true };
        day.places.push(substitute);
        assignedIds.add(substitute.id);
      }
    }
  }

  return dayClusters;
}

function dayAccepts(place, places, dayHotel, transportMode = "TRANSIT", startPoint = dayHotel, travelPool = []) {
  if (place.city && dayHotel?.city && place.city !== dayHotel.city) {
    return false;
  }
  return routeLegsWithinThreshold([...places, place], startPoint, transportMode, travelPool);
}

function getDayStartPoint(hotelAreas, dayIndex, currentDayHotel = null) {
  const currentHotel = hotelAreas[dayIndex] || currentDayHotel || hotelAreas[dayIndex - 1] || hotelAreas[0];
  const previousHotel = hotelAreas[dayIndex - 1];
  const isCitySwitchDay = dayIndex > 0 &&
    previousHotel?.city &&
    currentHotel?.city &&
    previousHotel.city !== currentHotel.city;
  return dayIndex === 0 || isCitySwitchDay
    ? (currentHotel || hotelAreas[0])
    : (previousHotel || currentHotel || hotelAreas[0]);
}

async function buildDayRoutes(dayClusters, hotelAreas, transportMode = "TRANSIT", reservePool = [], travelPool = []) {
  const transitLimiter = createTransitFetchLimiter(30, 5);
  const routes = [];

  for (const [index, cluster] of dayClusters.entries()) {
    const hotel = hotelAreas[index] || cluster.hotel || { x: 50, y: 50, label: "Hotel" };
    const startHotel = getDayStartPoint(hotelAreas, index, hotel) || hotel;
    const topCandidates = [...cluster.places]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const orderedPlaces = await orderRouteWithTransit(topCandidates, startHotel, transportMode, transitLimiter);
    const trimmedPlaces = index === dayClusters.length - 1
      ? trimLastDayForFlight(orderedPlaces, getLastDayCutoffMin(hotel, transportMode))
      : orderedPlaces;
    const places = await repairRouteLegThresholdWithTransit(trimmedPlaces, reservePool, startHotel, hotel.city, transportMode, travelPool, transitLimiter);
    const legs = buildRouteLegs(places, transportMode, startHotel);
    const vibeCounts = countBy(places, (place) => place.vibe);
    const routeCost = legs.reduce((sum, leg) => sum + leg.cost, 0);
    routes.push({
      day: index + 1,
      hotel,
      places,
      legs,
      routeCost,
      routeMinutes: legs.reduce((sum, leg) => sum + leg.minutes, 0),
      cost: places.reduce((sum, place) => sum + place.cost, 0) + 115 + routeCost,
      diversityWarning: Math.max(0, ...Object.values(vibeCounts)) > getMaxPerVibe(dayClusters.length),
      isLateArrivalDay: cluster.isLateArrivalDay || false,
      isCityTransferDay: cluster.isCityTransferDay || false,
      transferMode: cluster.transferMode || "",
      maxStops: cluster.maxStops
    });
  }

  return routes;
}

function createTransitFetchLimiter(maxCalls = 30, concurrency = 5) {
  let used = 0;
  let active = 0;
  const queue = [];

  const pump = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      fetchTransitMatrix(job.origin, job.destination)
        .then(job.resolve)
        .catch(() => job.resolve(null))
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  return {
    fetch(origin, destination) {
      const cached = getCachedTravelMatrix(origin, destination)?.transit;
      if (cached) return Promise.resolve(cached);
      if (used >= maxCalls) return Promise.resolve(null);
      used += 1;
      return new Promise((resolve) => {
        queue.push({ origin, destination, resolve });
        pump();
      });
    },
    get used() {
      return used;
    }
  };
}

async function getTransitMinutesForRefinement(origin, destination, transportMode, transitLimiter) {
  if (transportMode !== "TRANSIT") return travelTimeBetween(origin, destination, transportMode);
  const transit = await transitLimiter.fetch(origin, destination);
  return transit?.minutes || travelTimeBetween(origin, destination, transportMode);
}

function repairRouteLegThreshold(places, reservePool = [], startPoint = null, dayCity = "", transportMode = "TRANSIT", travelPool = []) {
  const threshold = getDynamicMaxTravel(transportMode, travelPool);
  const repaired = [...places];

  for (let index = 0; index < repaired.length; index += 1) {
    const previous = index === 0 ? startPoint : repaired[index - 1];
    if (!previous) continue;
    const legMinutes = travelTimeBetween(previous, repaired[index], transportMode);
    if (legMinutes <= threshold) continue;

    const routeIds = new Set(repaired.map((place) => place.id));
    const replacementIndex = reservePool
      .map((place, reserveIndex) => ({ place, reserveIndex }))
      .filter(({ place }) => {
        if (routeIds.has(place.id)) return false;
        if (dayCity && place.city !== dayCity) return false;
        return travelTimeBetween(previous, place, transportMode) <= threshold;
      })
      .sort((a, b) => b.place.score - a.place.score)[0]?.reserveIndex;

    if (replacementIndex === undefined) {
      repaired.splice(index, 1);
      index -= 1;
      continue;
    }

    const [replacement] = reservePool.splice(replacementIndex, 1);
    repaired[index] = { ...replacement, isSubstitute: true };
  }

  return repaired;
}

async function repairRouteLegThresholdWithTransit(places, reservePool = [], startPoint = null, dayCity = "", transportMode = "TRANSIT", travelPool = [], transitLimiter) {
  if (transportMode !== "TRANSIT") {
    return repairRouteLegThreshold(places, reservePool, startPoint, dayCity, transportMode, travelPool);
  }

  const threshold = getDynamicMaxTravel(transportMode, travelPool);
  const repaired = [...places];

  for (let index = 0; index < repaired.length; index += 1) {
    const previous = index === 0 ? startPoint : repaired[index - 1];
    if (!previous) continue;
    const legMinutes = await getTransitMinutesForRefinement(previous, repaired[index], transportMode, transitLimiter);
    if (legMinutes <= threshold) continue;

    const routeIds = new Set(repaired.map((place) => place.id));
    const reserveCandidates = reservePool
      .filter((place) => {
        if (routeIds.has(place.id)) return false;
        if (dayCity && place.city !== dayCity) return false;
        return true;
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const replacements = await Promise.all(reserveCandidates.map(async (place) => ({
      place,
      minutes: await getTransitMinutesForRefinement(previous, place, transportMode, transitLimiter)
    })));
    const replacement = replacements
      .filter((option) => option.minutes <= threshold)
      .sort((a, b) => b.place.score - a.place.score)[0]?.place;

    if (!replacement) {
      repaired.splice(index, 1);
      index -= 1;
      continue;
    }

    const replacementIndex = reservePool.findIndex((place) => place.id === replacement.id);
    if (replacementIndex >= 0) reservePool.splice(replacementIndex, 1);
    repaired[index] = { ...replacement, isSubstitute: true };
  }

  return repaired;
}

function getLastDayCutoffMin(lastDayHotel = null, transportMode = "TRANSIT") {
  if (state.departureAirport === "UNKNOWN") return null;
  const [h, m] = state.flightDepartureTime.split(":").map(Number);
  const flightMin = h * 60 + m;
  const airport = airportCoords[state.departureAirport];
  const toAirportMin = (airport && lastDayHotel)
    ? travelTimeBetween(lastDayHotel, airport, transportMode)
    : 30;
  return Math.floor(flightMin - 150 - toAirportMin);
}

function trimLastDayForFlight(route, cutoffMin) {
  if (cutoffMin === null) return route;
  const dayStartMin = 540;
  const averageStopMin = 75;
  return route.filter((_, index) => dayStartMin + (index + 1) * averageStopMin <= cutoffMin);
}

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)])
      .map((rest) => [item, ...rest])
  );
}

function routeTransitTotal(route, startPoint, transportMode = "TRANSIT") {
  return route.reduce((total, place, index) => {
    const previous = index === 0 ? startPoint : route[index - 1];
    return total + travelTimeBetween(previous, place, transportMode);
  }, 0);
}

async function routeTransitTotalWithTransit(route, startPoint, transportMode = "TRANSIT", transitLimiter) {
  let total = 0;
  for (let index = 0; index < route.length; index += 1) {
    const previous = index === 0 ? startPoint : route[index - 1];
    total += await getTransitMinutesForRefinement(previous, route[index], transportMode, transitLimiter);
  }
  return total;
}

function orderRoute(places, accommodation = { x: 50, y: 50 }, transportMode = "TRANSIT") {
  if (!places.length) return [];
  if (places.length <= 4) {
    return permutations(places)
      .map((route) => ({
        route,
        total: routeTransitTotal(route, accommodation, transportMode)
      }))
      .sort((a, b) => a.total - b.total)[0].route;
  }

  const maxStopsPerDay = 3;
  const remaining = [...places];
  const route = [];
  let current = accommodation;

  while (remaining.length && route.length < maxStopsPerDay) {
    const nextIndex = remaining
      .map((place, index) => {
        const transitMinutes = travelTimeBetween(current, place, transportMode);
        return {
          index,
          utility: place.score - transitMinutes * 1.5
        };
      })
      .sort((a, b) => b.utility - a.utility)[0].index;
    const [nextStop] = remaining.splice(nextIndex, 1);
    route.push(nextStop);
    current = nextStop;
  }

  return route;
}

async function orderRouteWithTransit(places, accommodation = { x: 50, y: 50 }, transportMode = "TRANSIT", transitLimiter) {
  if (transportMode !== "TRANSIT") return orderRoute(places, accommodation, transportMode);
  if (!places.length) return [];
  if (places.length <= 4) {
    const scoredRoutes = await Promise.all(permutations(places).map(async (route) => ({
      route,
      total: await routeTransitTotalWithTransit(route, accommodation, transportMode, transitLimiter)
    })));
    return scoredRoutes.sort((a, b) => a.total - b.total)[0].route;
  }

  const maxStopsPerDay = 3;
  const remaining = [...places];
  const route = [];
  let current = accommodation;

  while (remaining.length && route.length < maxStopsPerDay) {
    const scored = await Promise.all(remaining.map(async (place, index) => {
      const transitMinutes = await getTransitMinutesForRefinement(current, place, transportMode, transitLimiter);
      return {
        index,
        utility: place.score - transitMinutes * 1.5
      };
    }));
    const nextIndex = scored.sort((a, b) => b.utility - a.utility)[0].index;
    const [nextStop] = remaining.splice(nextIndex, 1);
    route.push(nextStop);
    current = nextStop;
  }

  return route;
}

function maxRouteLegMinutes(places, startPoint, transportMode = "TRANSIT") {
  if (!places.length) return 0;
  const orderedPlaces = orderRoute(places, startPoint, transportMode);
  const legs = buildRouteLegs(orderedPlaces, transportMode, startPoint);
  return Math.max(0, ...legs.map((leg) => leg.minutes));
}

function routeLegsWithinThreshold(places, startPoint, transportMode = "TRANSIT", travelPool = []) {
  return maxRouteLegMinutes(places, startPoint, transportMode) <= getDynamicMaxTravel(transportMode, travelPool);
}

function buildRouteLegs(places, transportMode = "TRANSIT", startPoint = null) {
  return places.map((place, index) => {
    const previous = index === 0 ? startPoint : places[index - 1];
    if (!previous) return { mode: "集合", label: "起点集合", minutes: 0, cost: 0 };
    const dist = distance(previous, place);
    const transit = transportMode === "TRANSIT" ? getCachedTravelMatrix(previous, place)?.transit : null;
    const minutes = transit?.minutes || Math.round(travelTimeBetween(previous, place, transportMode));
    const mode = transit
      ? (transit.minutes <= 20 ? "步行" : inferTransitModeFromApi(transit.raw, { mode: getLegMode(dist, transportMode) }))
      : (transportMode === "TRANSIT" ? (minutes <= 20 ? "步行" : "公交") : getLegMode(dist, transportMode));
    const cost = mode === "步行" ? 0 : mode === "公交" ? 4 : mode === "驾车" ? 12 : 7;
    return { mode, label: `${mode} ${minutes} 分钟`, minutes, cost };
  });
}

async function enrichTaxiLabels(trip) {
  if (!trip?.itineraryDays?.length) return trip;

  await Promise.all(trip.itineraryDays.map(async (day, dayIndex) => {
    const startPoint = getDayStartPoint(trip.hotelAreas, dayIndex, day.hotel);
    const enrichedLegs = await Promise.all(day.places.map(async (place, index) => {
      const previous = index === 0 ? startPoint : day.places[index - 1];
      const leg = day.legs[index] || buildRouteLegs([place], trip.transportMode, previous)[0];
      const drive = await fetchDriveMatrix(previous, place);
      return drive ? { ...leg, taxiLabel: buildTaxiLabel(drive, trip.country) } : leg;
    }));

    day.legs = enrichedLegs;
    day.routeCost = enrichedLegs.reduce((sum, leg) => sum + leg.cost, 0);
    day.routeMinutes = enrichedLegs.reduce((sum, leg) => sum + leg.minutes, 0);
    day.cost = day.places.reduce((sum, place) => sum + place.cost, 0) + 115 + day.routeCost;
  }));

  trip.legs = trip.itineraryDays.flatMap((day) => day.legs);
  trip.routeCost = trip.itineraryDays.reduce((sum, day) => sum + day.routeCost, 0);
  return trip;
}

async function enrichItineraryTravelDetails(trip) {
  if (!trip?.itineraryDays?.length) return trip;

  await Promise.all(trip.itineraryDays.map(async (day, dayIndex) => {
    const startPoint = getDayStartPoint(trip.hotelAreas, dayIndex, day.hotel);
    const enrichedLegs = [];

    for (let index = 0; index < day.places.length; index += 1) {
      const place = day.places[index];
      const previous = index === 0 ? startPoint : day.places[index - 1];
      const fallbackLeg = buildRouteLegs([place], trip.transportMode, previous)[0];
      const matrix = await fetchTravelMatrix(previous, place);
      enrichedLegs.push(matrix ? buildApiRouteLeg(matrix, fallbackLeg, trip.country) : fallbackLeg);
    }

    day.legs = enrichedLegs;
    day.routeCost = enrichedLegs.reduce((sum, leg) => sum + leg.cost, 0);
    day.routeMinutes = enrichedLegs.reduce((sum, leg) => sum + leg.minutes, 0);
    day.cost = day.places.reduce((sum, place) => sum + place.cost, 0) + 115 + day.routeCost;
  }));

  trip.legs = trip.itineraryDays.flatMap((day) => day.legs);
  trip.routeCost = trip.itineraryDays.reduce((sum, day) => sum + day.routeCost, 0);
  const hotelCost = trip.costBreakdown?.hotelCost || 0;
  const activityCost = trip.places.reduce((sum, place) => sum + place.cost, 0) + trip.days * 115 + trip.routeCost;
  trip.costBreakdown.activityCost = activityCost;
  trip.total = activityCost + hotelCost;
  trip.algorithm.routeMinutes = trip.legs.reduce((sum, leg) => sum + leg.minutes, 0);
  return trip;
}

function buildApiRouteLeg(matrix, fallbackLeg, country) {
  const transit = matrix.transit;
  const drive = matrix.drive;
  if (!transit) return fallbackLeg;

  const mode = transit.minutes <= 20
    ? "步行"
    : inferTransitModeFromApi(transit.raw, fallbackLeg);
  const cost = mode === "步行" ? 0 : fallbackLeg.cost;
  const taxiLabel = drive ? buildTaxiLabel(drive, country) : "";

  return {
    ...fallbackLeg,
    mode,
    label: `${mode} ${transit.minutes} 分钟`,
    minutes: transit.minutes,
    cost,
    taxiLabel
  };
}

function inferTransitModeFromApi(raw, fallbackLeg) {
  const payload = JSON.stringify(raw || {}).toLowerCase();
  if (payload.includes("subway") || payload.includes("metro") || payload.includes("rail") || payload.includes("train")) return "地铁";
  if (payload.includes("bus")) return "公交";
  return ["公交", "地铁"].includes(fallbackLeg?.mode) ? fallbackLeg.mode : "公交";
}

function buildTaxiLabel(drive, country) {
  const rate = getTaxiRate(country);
  const km = Math.max(0, (drive.distanceMeters || 0) / 1000);
  const fare = Math.round(rate.base + km * rate.perKm);
  return `🚕 约 ${drive.minutes} 分钟 · ~$${fare} 仅供参考`;
}

function getTaxiRate(country) {
  if (country === "England") return taxiRateUSD.UK;
  return taxiRateUSD[country] || taxiRateUSD.default;
}

function getLegMode(dist, transportMode = "TRANSIT") {
  if (transportMode === "DRIVING") return dist < 12 ? "步行" : "驾车";
  return dist < 15 ? "步行" : dist < 35 ? "公交" : "地铁";
}

function travelTimeBetween(a, b, transportMode = "TRANSIT") {
  if (transportMode === "TRANSIT") {
    const realTransit = getCachedTravelMatrix(a, b)?.transit?.minutes;
    if (realTransit) return realTransit;
  }
  return estimateTransitMinutes(a, b, transportMode);
}

function estimateTransitMinutes(place1, place2, transportMode = "TRANSIT") {
  const existingEstimate = estimateGridTransitMinutes(place1, place2, transportMode);

  if (!hasLatLng(place1) || !hasLatLng(place2)) {
    return existingEstimate;
  }

  const km = haversineKm(place1, place2);
  if (!Number.isFinite(km)) return existingEstimate;
  const urbanDistance = km * 1.2; // 城市街道弯曲系数

  if (transportMode === "DRIVING") return Math.round(km / 30 * 60 + 5);
  const walkingMinutes = Math.round(urbanDistance / 0.067);
  if (walkingMinutes > 20) {
    return Math.round(urbanDistance / 20 * 60 + 8);
  }
  return walkingMinutes;
}

function estimateGridTransitMinutes(a, b, transportMode = "TRANSIT") {
  const dist = distance(a, b);
  if (transportMode === "DRIVING") {
    return dist < 20 ? dist * 2 : dist * 1;
  }
  if (dist < 15) return dist * 3;
  if (dist < 35) return dist * 2;
  return dist * 1.2;
}

function haversineKm(place1, place2) {
  const R = 6371;
  const dLat = (place2.lat - place1.lat) * Math.PI / 180;
  const dLng = (place2.lng - place1.lng) * Math.PI / 180;
  const lat1 = place1.lat * Math.PI / 180;
  const lat2 = place2.lat * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) *
    Math.cos(lat2) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function hasLatLng(place) {
  return Number.isFinite(Number(place?.lat)) && Number.isFinite(Number(place?.lng));
}

function getDynamicMaxTravel(transportMode, places) {
  const base = maxTravelByMode[transportMode] || 50;
  if (places.length < 2) return base;
  let total = 0;
  let count = 0;
  for (let i = 0; i < places.length; i += 1) {
    for (let j = i + 1; j < places.length; j += 1) {
      total += travelTimeBetween(places[i], places[j], transportMode);
      count += 1;
    }
  }
  const avgDist = total / count;
  if (avgDist > 35) return base + 20;
  if (avgDist > 25) return base + 10;
  return base;
}

function estimateTotal(places, days, transportMode = "TRANSIT") {
  const routeCost = buildRouteLegs(orderRoute(places, { x: 50, y: 50 }, transportMode), transportMode).reduce((sum, leg) => sum + leg.cost, 0);
  return places.reduce((sum, place) => sum + place.cost, 0) + days * 115 + routeCost;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value) {
  return (value || "").toLowerCase().replace(/\s+/g, "");
}

function normalizeForMatch(text) {
  const lowerWithSpaces = (text || "").toLowerCase();
  return lowerWithSpaces
    .replace(/\s+/g, "")
    .replace(/[·•\-]/g, "");
}

function hashString(value) {
  return [...value].reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) >>> 0, 0);
}

function countBy(items, getter) {
  return items.reduce((counts, item) => {
    const key = getter(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function renderTrip() {
  const trip = state.latestTrip;
  if (!trip) return;

  if (exportPdfButton) {
    exportPdfButton.style.display = "";
    exportPdfButton.textContent = state.language === "en" ? "Export PDF" : "导出 PDF";
  }
  const hotelSummary = summarizeHotelAreas(trip.hotelAreas);
  title.textContent = `${trip.plan.label} · ${trip.days} 天 · ${hotelSummary}`;
  if (itineraryDisclaimer) {
    itineraryDisclaimer.textContent = state.language === "en"
      ? "* All times are in local time · All prices are in USD and for reference only"
      : "* 所有时间均为当地时间 · 所有价格以美元（USD）计算，仅供参考";
  }
  personaCopy.textContent = buildPersona(trip);
  renderAlgorithm(trip);
  renderAlerts(trip);
  renderBudget(trip);
  renderGoogleMap(trip);
  renderReservePool(trip);
  renderItinerary(trip);
  updateHash(trip);
}

function renderAlgorithm(trip) {
  const chips = [
    [state.language === "en" ? "Candidate pool" : "候选池", `${trip.algorithm.candidateCount} places`],
    [state.language === "en" ? "Nominations" : "提名点", `${trip.algorithm.nominatedCount} nominated`],
    [state.language === "en" ? "Reserve pool" : "备用池", `${trip.algorithm.reserveCount} reserve`],
    [state.language === "en" ? "Substitutes" : "替换点", `${trip.algorithm.substituteCount} substitute`],
    [state.language === "en" ? "Day clusters" : "日程聚类", `${trip.itineraryDays.length} day clusters`],
    [state.language === "en" ? "Discovery" : "发现模式", trip.algorithm.discoveryMode ? `${trip.algorithm.systemCount} system stops` : "nominations first"],
    [state.language === "en" ? "Transport" : "交通方式", `${trip.algorithm.transportMode} · ${trip.algorithm.maxTravelMin} min`],
    [state.language === "en" ? "Hotel cost" : "酒店成本", `$${trip.costBreakdown.hotelCost}`],
    [state.language === "en" ? "Avg score" : "综合评分", `${trip.algorithm.averageScore}/100`],
    [state.language === "en" ? "Route travel" : "路线交通", `${trip.algorithm.routeMinutes} min`],
    [state.language === "en" ? "Constraint repair" : "约束修复", trip.algorithm.budgetAction]
  ];
  algorithmCopy.innerHTML = chips
    .map(([label, value]) => `
      <div>
        <strong>${label}</strong>
        <span>${value}</span>
      </div>
    `)
    .join("");
}

function buildPersona(trip) {
  const names = trip.groupVibes
    .map((id) => vibeOptions.find((item) => item[0] === id)?.[1])
    .filter(Boolean)
    .slice(0, 5)
    .join("、");
  const over = trip.total > trip.budgetMax;
  if (state.language === "en") {
    return `Group vibes cluster around ${names || "classic city experiences"}. Scoring uses nominations, group vibe consensus, and budget only. Transport mode changes the per-day feasibility threshold and leg time estimates. Current mode: ${trip.transportMode}, max leg window: ${trip.algorithm.maxTravelMin} min, ${over ? "but this route needs cost trimming." : "and the route stays within budget."}`;
  }
  return `团队偏好集中在 ${names || "城市经典体验"}。当前评分只看成员提名、群体氛围共识和预算；交通方式会改变单日可达阈值和路段耗时，当前使用 ${trip.transportMode}，单日移动阈值为 ${trip.algorithm.maxTravelMin} 分钟，${over ? "但当前路线需要压缩高消费点" : "并保持预算在可控区间"}。`;
}

function formatBudgetAction(total, budgetMin, budgetMax) {
  if (state.language === "en") {
    if (total > budgetMax) return "Over total budget; trim high-cost anchors";
    if (total < budgetMin) return "Below target budget; room to upgrade";
    return "Within total budget";
  }
  if (total > budgetMax) return "预算仍高于总上限，建议减少高消费锚点";
  if (total < budgetMin) return "预算偏低，仍有体验升级空间";
  return "预算落在目标区间";
}

function summarizeHotelAreas(hotelAreas) {
  const labels = [...new Set(hotelAreas.map((hotel) => hotel.label))];
  if (state.language === "en") {
    return labels.length === 1 ? `staying in ${labels[0]}` : `hotel moves: ${labels.join(" → ")}`;
  }
  return labels.length === 1 ? `全程住在 ${labels[0]}` : `换住 ${labels.join(" → ")}`;
}

function renderAlerts(trip) {
  const departure = new Date(departureInput.value);
  const today = new Date();
  const daysUntil = Math.ceil((departure - today) / (1000 * 60 * 60 * 24));
  const visaDays = typeof trip.plan.visaDays === "number"
    ? trip.plan.visaDays
    : trip.plan.visaDays?.[nationalityInput.value] ?? 0;
  const alerts = [];

  if (visaDays > 0 && daysUntil < visaDays) {
    alerts.push(["danger", state.language === "en"
      ? `Visa warning: departure is about ${daysUntil} days away; static rules suggest ${visaDays} days for processing.`
      : `签证前置预警：距离出发约 ${daysUntil} 天，静态库建议预留 ${visaDays} 天办理周期。`]);
  } else if (visaDays > 0) {
    alerts.push(["warning", state.language === "en"
      ? `Visa reminder: this destination usually needs ${visaDays} days; your timeline looks workable.`
      : `签证提醒：该目的地建议预留 ${visaDays} 天办理周期，目前时间窗口基本可行。`]);
  }

  const totalCap = trip.budgetMax;
  const ratio = totalCap > 0 ? trip.total / totalCap : 0;
  const overPercent = Math.round((ratio - 1) * 100);
  if (ratio > 1.15) {
    alerts.push(["danger", state.language === "en"
      ? `⚠️ Over budget by ${overPercent}%; consider lowering hotel stars or removing high-cost stops.`
      : `⚠️ 超出预算 ${overPercent}%，建议降低酒店星级或减少高消费景点。`]);
  } else if (ratio > 1.0) {
    alerts.push(["warning", state.language === "en"
      ? `💛 Budget is ${overPercent}% over, within the reasonable flexibility range.`
      : `💛 预算略超 ${overPercent}%，在合理弹性范围内。`]);
  } else if (ratio > 0.85) {
    alerts.push(["success", state.language === "en"
      ? "✅ Budget is within the target range."
      : "✅ 预算在目标区间内。"]);
  } else {
    alerts.push(["info", state.language === "en"
      ? "💙 Budget is on the low side; there is still room to upgrade."
      : "💙 预算偏低，仍有升级空间。"]);
  }

  const concentratedDays = trip.itineraryDays.filter((day) => day.diversityWarning).map((day) => day.day);
  if (concentratedDays.length) {
    alerts.push(["warning", state.language === "en"
      ? `Diversity warning: Day ${concentratedDays.join(", Day ")} has concentrated vibes.`
      : `日程多样性提醒：Day ${concentratedDays.join("、Day ")} 出现同类氛围集中，可考虑跨日调换。`]);
  }

  if (trip.algorithm.substituteCount) {
    alerts.push(["warning", state.language === "en"
      ? `Reachability repair: ${trip.algorithm.substituteCount} stops were substituted because travel exceeded ${trip.algorithm.maxTravelMin} min.`
      : `路线可达性修复：${trip.algorithm.substituteCount} 个点因单日移动超过 ${trip.algorithm.maxTravelMin} 分钟被备用池替换。`]);
  }

  const cutoff = getLastDayCutoffMin(
    state.latestTrip?.hotelAreas?.[state.latestTrip.days - 1],
    state.latestTrip?.transportMode
  );
  if (cutoff !== null) {
    const hh = String(Math.floor(cutoff / 60)).padStart(2, "0");
    const mm = String(Math.floor(cutoff % 60)).padStart(2, "0");
    alerts.push(["warning", state.language === "en"
      ? `✈ Last day: must leave last stop by ${hh}:${mm} to catch flight.`
      : `✈ 最后一天：需在 ${hh}:${mm} 前离开最后一个景点以赶上航班。`
    ]);
  }

  alertStack.innerHTML = alerts.length
    ? alerts.map(([type, copy]) => `<div class="alert ${type}">${copy}</div>`).join("")
    : `<div class="alert">${state.language === "en" ? "Route is feasible: visa window, budget, and meetup rhythm have no major warnings." : "团队路线可执行：签证窗口、预算区间和集合节奏暂未触发强预警。"}</div>`;
}

function renderBudget(trip) {
  const totalBudgetCap = trip.budgetMax;
  const ratio = totalBudgetCap > 0 ? trip.total / totalBudgetCap : 0;
  const hotelCostPerNight = trip.costBreakdown.hotelCostPerNight;
  const hotelCostPerPersonPerNight = trip.costBreakdown.hotelCostPerPersonPerNight;
  const activityBudgetPerDay = Math.round(trip.costBreakdown.activityBudgetPerDay);
  const travelerCount = trip.costBreakdown.travelerCount;
  const roomsNeeded = trip.costBreakdown.roomsNeeded;
  const hotelCostPerRoomPerNight = Math.round(hotelCostPerNight / Math.max(1, roomsNeeded));
  budgetTotal.textContent = `$${trip.total} / $${trip.budgetMax}`;
  budgetFill.style.width = `${Math.min(100, Math.round(ratio * 100))}%`;
  budgetFill.style.background = ratio > 1.15 ? "var(--coral)" : ratio > 1.0 ? "var(--gold)" : "var(--mint)";
  budgetCaption.textContent = state.language === "en"
    ? `${travelerCount} travelers · ${roomsNeeded} room(s) · $${hotelCostPerRoomPerNight}/room/night · $${hotelCostPerPersonPerNight}/person/night · Activity budget $${activityBudgetPerDay}/day/person · * Hotel cost is an estimate`
    : `${travelerCount} 人出行 · ${roomsNeeded} 间客房 · $${hotelCostPerRoomPerNight}/间/晚 · 每人分摊 $${hotelCostPerPersonPerNight}/晚 · 活动预算 $${activityBudgetPerDay}/天/人 · * 酒店费用为估算值`;
}

function renderReservePool(trip) {
  if (!reservePoolList) return;

  if (reservePoolSection) reservePoolSection.style.display = "";

  const finalIds = new Set(trip.places.map((place) => place.id));
  const reserveCandidates = (trip.allCandidates || [])
    .filter((place) => !finalIds.has(place.id))
    .sort((a, b) => {
      const aVotes = getWishlistCount(a.id);
      const bVotes = getWishlistCount(b.id);
      if (aVotes !== bVotes) return bVotes - aVotes;
      return b.score - a.score;
    });

  if (reservePoolCount) {
    reservePoolCount.textContent = state.language === "en"
      ? `${reserveCandidates.length} places`
      : `${reserveCandidates.length} 个地点`;
  }

  if (reservePoolTitle) {
    reservePoolTitle.textContent = state.language === "en"
      ? "Reserve candidate pool"
      : "备选地点池";
  }

  if (!reserveCandidates.length) {
    reservePoolList.innerHTML = `
      <p style="color:var(--muted);font-size:13px">
        ${state.language === "en" ? "No reserve candidates." : "暂无备选地点。"}
      </p>`;
    return;
  }

  reservePoolList.innerHTML = reserveCandidates
    .map((place) => {
      const vibe = vibeOptions.find((item) => item[0] === place.vibe);
      const vibeLabel = vibe ? (state.language === "zh" ? vibe[1] : vibe[0]) : place.vibe;
      const wishlistCount = getWishlistCount(place.id);
      const wishlisted = isPlaceWishlisted(place.id);
      const canEdit = canEditItinerary();
      const wishlistLabel = state.language === "en"
        ? `${wishlistCount} want to go`
        : `${wishlistCount}人想去`;
      return `
        <div class="reserve-card"
             data-reserve-id="${place.id}"
             data-lat="${place.lat || ""}"
             data-lng="${place.lng || ""}">
          <div class="reserve-card-topline">
            <div class="reserve-card-name">${place.name}</div>
            <div class="reserve-card-actions">
              <button class="reserve-wishlist-btn"
                      type="button"
                      data-wishlist-id="${place.id}"
                      aria-label="${state.language === "en" ? "Want to go" : "想去"}">
                ${wishlisted ? "❤️" : "🤍"}
              </button>
              ${canEdit ? `
                <button class="reserve-add-btn"
                        type="button"
                        data-add-id="${place.id}">
                  ${state.language === "en" ? "Add to itinerary" : "加入行程"}
                </button>
              ` : ""}
            </div>
          </div>
          <div class="reserve-card-meta">
            <span class="reserve-card-vibe">${vibeLabel}</span>
            <span class="reserve-card-cost">$${place.cost}</span>
            ${landmarkBadgeHtml(place)}
            ${wishlistCount ? `<span class="reserve-wishlist-count">❤️ ${wishlistLabel}</span>` : ""}
          </div>
          <div class="reserve-card-score">
            ${place.score}/100 ·
            ${place.source === "nominated" ? "🏷 提名" : "🔍 推荐"}
          </div>
        </div>
      `;
    })
    .join("");
}

function getWishlistCount(placeId) {
  if (sharedTripId || activeInviteTrip?.id) return wishlistState.counts.get(placeId) || 0;
  return localWishlist.has(placeId) ? 1 : 0;
}

function isPlaceWishlisted(placeId) {
  if (sharedTripId || activeInviteTrip?.id) return wishlistState.mine.has(placeId);
  return localWishlist.has(placeId);
}

function canEditItinerary() {
  return isSharedPlanner === true || !(sharedTripId || activeInviteTrip?.id || window._activeTripId);
}

function showAddToItineraryModal(place) {
  const trip = state.latestTrip;
  if (!trip || !place) return;

  const modal = document.createElement("div");
  modal.className = "invite-modal-backdrop";
  const rows = trip.itineraryDays.map((day, dayIndex) => `
    <button class="itinerary-edit-row"
            type="button"
            data-add-day="${dayIndex}">
      <span>Day ${day.day}</span>
      <strong>${day.places.length} ${state.language === "en" ? "stops" : "个景点"}</strong>
    </button>
  `).join("");

  modal.innerHTML = `
    <div class="invite-modal itinerary-edit-modal" role="dialog" aria-modal="true">
      <h3>${state.language === "en" ? "Add to which day?" : "加入哪一天？"}</h3>
      <p class="muted">${place.name}</p>
      <div class="itinerary-edit-list">${rows}</div>
      <button class="secondary-button itinerary-edit-cancel" type="button">
        ${state.language === "en" ? "Cancel" : "取消"}
      </button>
    </div>
  `;
  document.body.appendChild(modal);

  modal.querySelector(".itinerary-edit-cancel")?.addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.remove();
  });
  modal.querySelectorAll(".itinerary-edit-row").forEach((button) => {
    button.addEventListener("click", async () => {
      const dayIndex = Number(button.dataset.addDay);
      const day = trip.itineraryDays[dayIndex];
      if (day?.places?.length >= 3) {
        showFullDayConfirm(() => addReservePlaceToDay(place, dayIndex));
        modal.remove();
        return;
      }
      modal.remove();
      await addReservePlaceToDay(place, dayIndex);
    });
  });
}

function showFullDayConfirm(onConfirm) {
  const modal = document.createElement("div");
  modal.className = "invite-modal-backdrop";
  modal.innerHTML = `
    <div class="invite-modal itinerary-edit-modal" role="dialog" aria-modal="true">
      <h3>${state.language === "en" ? "This day already has 3 stops. Confirm?" : "该天已有3个景点，确认添加？"}</h3>
      <div class="invite-link-row">
        <button class="secondary-button itinerary-edit-cancel" type="button">
          ${state.language === "en" ? "Cancel" : "取消"}
        </button>
        <button class="primary-button itinerary-edit-confirm" type="button">
          ${state.language === "en" ? "Confirm" : "确认"}
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector(".itinerary-edit-cancel")?.addEventListener("click", () => modal.remove());
  modal.querySelector(".itinerary-edit-confirm")?.addEventListener("click", async () => {
    modal.remove();
    await onConfirm();
  });
}

async function removeItineraryStop(dayIndex, stopIndex) {
  const trip = state.latestTrip;
  const day = trip?.itineraryDays?.[dayIndex];
  if (!trip || !day || !day.places?.[stopIndex]) return;

  const [removedStop] = day.places.splice(stopIndex, 1);
  trip.allCandidates = Array.isArray(trip.allCandidates) ? trip.allCandidates : [];
  if (!trip.allCandidates.some((candidate) => candidate.id === removedStop.id)) {
    trip.allCandidates.push(removedStop);
  }
  const startPoint = getDayStartPoint(trip.hotelAreas, dayIndex, day.hotel);
  day.places = orderRoute(day.places, startPoint, trip.transportMode);
  await recalculateDayTravel(trip, dayIndex);
  await finishItineraryEdit(trip, state.language === "en" ? "Stop removed" : "已移出");
}

async function addReservePlaceToDay(place, dayIndex) {
  const trip = state.latestTrip;
  const day = trip?.itineraryDays?.[dayIndex];
  if (!trip || !day || !place) return;

  trip.allCandidates = Array.isArray(trip.allCandidates) ? trip.allCandidates : [];
  if (!trip.allCandidates.some((candidate) => candidate.id === place.id)) {
    trip.allCandidates.push(place);
  }
  if (!day.places.some((candidate) => candidate.id === place.id)) {
    day.places.push({ ...place, isSubstitute: false });
  }
  const startPoint = getDayStartPoint(trip.hotelAreas, dayIndex, day.hotel);
  day.places = orderRoute(day.places, startPoint, trip.transportMode);
  await recalculateDayTravel(trip, dayIndex);
  await finishItineraryEdit(trip, state.language === "en" ? "Added to itinerary" : "已加入行程");
}

async function recalculateDayTravel(trip, dayIndex) {
  const day = trip.itineraryDays[dayIndex];
  const startPoint = getDayStartPoint(trip.hotelAreas, dayIndex, day.hotel);
  const legs = [];

  for (let index = 0; index < day.places.length; index += 1) {
    const place = day.places[index];
    const previous = index === 0 ? startPoint : day.places[index - 1];
    const fallbackLeg = buildRouteLegs([place], trip.transportMode, previous)[0];
    const matrix = await fetchTravelMatrix(previous, place);
    legs.push(matrix ? buildApiRouteLeg(matrix, fallbackLeg, trip.country) : fallbackLeg);
  }

  day.legs = legs;
  day.routeCost = legs.reduce((sum, leg) => sum + leg.cost, 0);
  day.routeMinutes = legs.reduce((sum, leg) => sum + leg.minutes, 0);
  day.cost = day.places.reduce((sum, place) => sum + place.cost, 0) + 115 + day.routeCost;
}

async function finishItineraryEdit(trip, toastMessage) {
  recomputeTripAfterEdit(trip);
  renderTrip();
  if (sharedTripId) await persistGeneratedItinerary();
  showToast(toastMessage);
}

function recomputeTripAfterEdit(trip) {
  trip.places = trip.itineraryDays.flatMap((day) => day.places);
  trip.legs = trip.itineraryDays.flatMap((day) => day.legs || []);
  trip.routeCost = trip.itineraryDays.reduce((sum, day) => sum + (day.routeCost || 0), 0);
  const hotelCost = trip.costBreakdown?.hotelCost || 0;
  const activityCost = trip.places.reduce((sum, place) => sum + place.cost, 0) + trip.days * 115 + trip.routeCost;
  trip.costBreakdown.activityCost = activityCost;
  trip.total = activityCost + hotelCost;
  trip.algorithm.routeMinutes = trip.legs.reduce((sum, leg) => sum + leg.minutes, 0);
  trip.algorithm.selectedCount = trip.places.length;
  trip.algorithm.averageScore = Math.round(trip.places.reduce((sum, place) => sum + place.score, 0) / Math.max(1, trip.places.length));
  trip.algorithm.substituteCount = trip.places.filter((place) => place.isSubstitute).length;
  trip.algorithm.systemCount = trip.places.filter((place) => place.source === "system").length;
  const finalIds = new Set(trip.places.map((place) => place.id));
  trip.algorithm.reserveCount = (trip.allCandidates || []).filter((place) => !finalIds.has(place.id)).length;
}

async function toggleReserveWishlist(placeId) {
  if (!placeId) return;
  const tripId = sharedTripId || activeInviteTrip?.id || window._activeTripId;
  if (!tripId || !currentSharedMemberName) {
    if (localWishlist.has(placeId)) localWishlist.delete(placeId);
    else localWishlist.add(placeId);
    if (state.latestTrip) renderReservePool(state.latestTrip);
    return;
  }

  const supabase = await getSupabaseBrowserClient();
  const { data: member, error } = await supabase
    .from("members")
    .select("id,wishlist")
    .eq("trip_id", tripId)
    .ilike("name", currentSharedMemberName)
    .maybeSingle();
  if (error || !member) {
    if (error) console.error(error);
    return;
  }

  const current = Array.isArray(member.wishlist) ? member.wishlist : [];
  const next = new Set(current.filter(Boolean));
  if (next.has(placeId)) next.delete(placeId);
  else next.add(placeId);

  const { error: updateError } = await supabase
    .from("members")
    .update({ wishlist: [...next] })
    .eq("id", member.id);
  if (updateError) {
    console.error(updateError);
    return;
  }

  wishlistState.mine = new Set(next);
  await renderInviteProgress(tripId);
  if (state.latestTrip) renderReservePool(state.latestTrip);
}

function renderGoogleMap(trip) {
  if (routeSummary) routeSummary.textContent = `${trip.plan.center} · ${trip.days} 天分组 · ${trip.algorithm.routeMinutes} 分钟交通`;
  if (!googleMap || !window.google) return;
  clearMap();

  const bounds = new google.maps.LatLngBounds();

  // 每天的酒店标记
  trip.hotelAreas.forEach((hotel, index) => {
    if (!hotel.lat || !hotel.lng) return;
    const position = { lat: hotel.lat, lng: hotel.lng };
    const marker = new google.maps.Marker({
      position,
      map: googleMap,
      label: {
        text: `H${index + 1}`,
        color: "white",
        fontWeight: "bold",
        fontSize: "11px"
      },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 16,
        fillColor: "#f0a04b",
        fillOpacity: 1,
        strokeColor: "white",
        strokeWeight: 2
      },
      title: `Day ${index + 1}: ${hotel.label}`
    });
    bounds.extend(position);
    mapMarkers.push(marker);
  });

  // 每天的路线和地点
  trip.itineraryDays.forEach((day, dayIndex) => {
    const color = DAY_COLORS[dayIndex % DAY_COLORS.length];
    const path = [];

    day.places.forEach((place, placeIndex) => {
      if (!place.lat || !place.lng) return;
      const position = { lat: place.lat, lng: place.lng };

      const marker = new google.maps.Marker({
        position,
        map: googleMap,
        label: {
          text: String(placeIndex + 1),
          color: "white",
          fontWeight: "bold",
          fontSize: "11px"
        },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 14,
          fillColor: color,
          fillOpacity: 1,
          strokeColor: "white",
          strokeWeight: 2
        },
        title: `Day ${day.day}: ${place.name}`
      });

      // 点击显示详情
      marker.addListener("click", () => {
        const globalIndex = trip.places.indexOf(place);
        if (globalIndex >= 0) showDetail(globalIndex);
      });

      bounds.extend(position);
      mapMarkers.push(marker);
      path.push(position);
    });

    // 画路线
    if (path.length > 1) {
      const polyline = new google.maps.Polyline({
        path,
        geodesic: true,
        strokeColor: color,
        strokeOpacity: 0.8,
        strokeWeight: 3
      });
      polyline.setMap(googleMap);
      mapPolylines.push(polyline);
    }
  });

  // 自动缩放到所有地点
  if (!bounds.isEmpty()) {
    googleMap.fitBounds(bounds);
  }
}

function renderMap(trip) {
  if (!routeLines || !mapPoints) return;
  if (routeSummary) routeSummary.textContent = `${trip.plan.center} · ${trip.days} 天分组 · ${trip.algorithm.routeMinutes} 分钟交通`;
  if (routeLines) routeLines.innerHTML = "";
  if (mapPoints) mapPoints.innerHTML = trip.hotelAreas
    .map((hotel, index) => `
      <button class="home-marker" type="button" style="left: ${hotel.x}%; top: ${hotel.y}%;" title="Day ${index + 1}: ${hotel.label}">
        H${index + 1}
      </button>
    `)
    .join("");

  let globalIndex = 0;
  trip.itineraryDays.forEach((day, dayIndex) => {
    day.places.forEach((place, index) => {
      const next = day.places[index + 1];
      if (next) {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", place.x);
        line.setAttribute("y1", place.y);
        line.setAttribute("x2", next.x);
        line.setAttribute("y2", next.y);
        line.setAttribute("stroke", dayIndex % 2 ? "#1c6b7a" : "#d69b25");
        line.setAttribute("stroke-width", "0.85");
        line.setAttribute("stroke-linecap", "round");
        line.setAttribute("stroke-dasharray", day.diversityWarning ? "2 1.5" : "0");
        routeLines.appendChild(line);
      }

      const button = document.createElement("button");
      button.className = `map-point ${globalIndex === state.activeIndex ? "active" : ""}`;
      button.type = "button";
      button.style.left = `${place.x}%`;
      button.style.top = `${place.y}%`;
      button.textContent = day.day;
      button.title = `Day ${day.day}: ${place.name}`;
      button.addEventListener("click", () => showDetail(globalIndex));
      mapPoints.appendChild(button);
      globalIndex += 1;
    });
  });
}
void renderMap;

function renderItinerary(trip) {
  placeCount.textContent = `${trip.itineraryDays.length} days`;
  let globalIndex = 0;
  itineraryList.innerHTML = trip.itineraryDays
    .map((day) => {
      const dayColor = DAY_COLORS[(day.day - 1) % DAY_COLORS.length];
      const canEdit = canEditItinerary();
      const cards = day.places.map((place, index) => {
        const currentIndex = globalIndex;
        globalIndex += 1;
        const transport = transportIconForLeg(day.legs[index]);
        const leg = day.legs[index];
        const names = [...new Set([...place.nominations.map((item) => item.member), ...place.supporters.map((traveler) => traveler.name)])].join("、") || "系统推荐";
        return `
          <article class="place-card" data-index="${currentIndex}">
            <div class="place-line">
              <h3>
                <span style="
                  display: inline-block;
                  width: 20px;
                  height: 20px;
                  border-radius: 50%;
                  background: ${dayColor};
                  color: white;
                  font-size: 11px;
                  font-weight: 700;
                  text-align: center;
                  line-height: 20px;
                  margin-right: 6px;
                  vertical-align: middle;
	                ">${index + 1}</span>
	                ${place.name}${place.isSubstitute ? " · SUBSTITUTE" : ""}
	              </h3>
	              <div class="place-card-actions">
	                <strong>${place.score}/100</strong>
                  ${landmarkBadgeHtml(place)}
	                ${canEdit ? `
	                  <button class="stop-remove-btn"
	                          type="button"
	                          data-remove-day="${day.day - 1}"
	                          data-remove-stop="${index}">
	                    ${state.language === "en" ? "Remove" : "移出"}
	                  </button>
	                ` : ""}
	              </div>
	            </div>
            ${getPlaceDescription(place) ? `<p>${getPlaceDescription(place)}</p>` : ""}
            <div class="route-meta">
              <span class="route-chip">${transport} ${leg.label}</span>
              ${leg.taxiLabel ? `<span class="route-chip taxi-chip">${leg.taxiLabel}</span>` : ""}
              <span class="route-chip">${place.consensus}% 共识 · ${names}</span>
              <span class="route-chip">$${place.cost} · ${place.rationale}</span>
            </div>
          </article>
        `;
      }).join("");

      return `
        <section class="day-group" style="border-left: 3px solid ${dayColor}; padding-left: 12px;">
          <div class="day-heading">
            <strong style="color: ${dayColor}">
              Day ${day.day}
            </strong>
            <span>${day.hotel.label} · ${day.places.length} ${state.language === "en" ? "stops" : "站"} · ${day.routeMinutes} min · $${day.cost}${day.isLateArrivalDay ? (state.language === "en" ? " · ✈ Late arrival — no stops scheduled for Day 1" : " · ✈ 到达时间较晚，第一天不安排行程") : ""}${day.isCityTransferDay ? (state.language === "en" ? ` · ${transferIconForMode(day.transferMode)} City transfer day · Light schedule recommended` : ` · ${transferIconForMode(day.transferMode)} 换城日 · 建议轻行程`) : ""}${day.diversityWarning ? (state.language === "en" ? " · ⚠ vibe concentration" : " · ⚠ 氛围集中") : ""}${day.places.some((place) => place.isSubstitute) ? " · substitute" : ""}</span>
          </div>
          ${cards || `<p class="muted">No stops assigned yet.</p>`}
        </section>
      `;
    })
    .join("");
}

function transportIconForLeg(leg) {
  if (!leg || leg.mode === "集合") return "📍";
  if (leg.mode === "步行") return "🚶";
  if (leg.mode === "驾车") return "🚗";
  if (leg.mode === "公交") return "🚌";
  return "🚇";
}

function transferIconForMode(mode) {
  return mode === "flight" ? "✈️" : mode === "bus" ? "🚌" : "🚄";
}

function getPlaceDescription(place) {
  return place.editorialSummary || place.description || "";
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function isLandmarkPlace(place) {
  return (place?.userRatingCount || 0) > 10000;
}

function landmarkBadgeHtml(place) {
  if (!isLandmarkPlace(place)) return "";
  return `<span class="landmark-badge">${state.language === "en" ? "🏛 Landmark" : "🏛 著名景点"}</span>`;
}

function renderDetailModal(place, options = {}) {
  const trip = state.latestTrip;
  detailImage.src = place.image || "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=82";
  detailImage.alt = place.name || "";
  const placeCity = place.city || trip?.destination || trip?.plan?.label || "";
  detailKicker.textContent = options.kicker || (state.language === "en"
    ? `${placeCity}${trip?.country ? `, ${trip.country}` : ""} · Route detail`
    : `${placeCity}${trip?.country ? `，${t("countryNames")[trip.country] || trip.country}` : ""} · 路径详情`);
  detailTitle.textContent = place.name || "";

  const description = getPlaceDescription(place);
  const address = place.formattedAddress || "";
  const leg = options.leg || null;
  const supporters = (place.supporters || []).map((traveler) => traveler.name);
  const nominatedBy = (place.nominations || []).map((item) => `${item.member} #${item.rank}`);
  const matchReason = [
    place.rationale,
    nominatedBy.length ? (state.language === "en" ? `Nominated by ${nominatedBy.join(", ")}` : `成员提名：${nominatedBy.join("、")}`) : "",
    place.source && place.source !== "nominated" ? (state.language === "en" ? "System discovery candidate" : "系统发现候选") : ""
  ].filter(Boolean).join(" · ");
  const vibeMatch = supporters.length
    ? supporters.join(state.language === "en" ? ", " : "、")
    : (state.language === "en" ? "No direct member vibe match" : "暂无直接成员氛围匹配");
  const metadataRows = [
    address ? [state.language === "en" ? "Address" : "地址", address] : null,
    place.cost !== undefined ? [state.language === "en" ? "Estimated cost" : "预计单点花费", `$${place.cost}`] : null,
    leg?.label ? [state.language === "en" ? "Transit from previous stop" : "从上一站衔接方式", leg.label] : null,
    matchReason ? [state.language === "en" ? "Match reason" : "推荐理由", matchReason] : null,
    [state.language === "en" ? "Vibe match" : "氛围匹配", vibeMatch],
    place.score !== undefined ? [state.language === "en" ? "Score" : "综合评分", `${place.score}/100`] : null
  ].filter(Boolean);

  detailBody.innerHTML = `
    ${description ? `<p class="detail-summary">${escapeHtml(description)}</p>` : ""}
    ${metadataRows.length ? `
      <div class="detail-meta">
        ${metadataRows.map(([label, value]) => `
          <div><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>
        `).join("")}
      </div>
    ` : ""}
  `;
  detailBody.style.display = description || metadataRows.length ? "" : "none";
  if (!dialog.open) dialog.showModal();
}

async function fetchReservePlaceDetails(place) {
  if (!place) return null;
  const cacheKey = place.googlePlaceId || place.id || place.name;
  if (placeDetailsCache.has(cacheKey)) return placeDetailsCache.get(cacheKey);

  let details = null;

  try {
    if (place.googlePlaceId) {
      const res = await fetch(`/api/places?type=details&placeId=${encodeURIComponent(place.googlePlaceId)}`);
      const data = await res.json();
      if (!data.error) details = data;
    }
    if (!details) {
      const params = new URLSearchParams({
        type: "nomination",
        query: place.name || ""
      });
      if (place.lat && place.lng) {
        params.set("lat", place.lat);
        params.set("lng", place.lng);
      }
      const res = await fetch(`/api/places?${params}`);
      const data = await res.json();
      details = data.places?.[0] || null;
    }
  } catch {}

  const photoName = details?.photos?.[0]?.name || null;
  const enriched = {
    ...place,
    image: photoName ? `/api/photo?name=${encodeURIComponent(photoName)}` : place.image,
    editorialSummary: details?.editorialSummary?.text || place.editorialSummary || "",
    formattedAddress: details?.formattedAddress || place.formattedAddress || "",
    googlePlaceId: details?.id || place.googlePlaceId || "",
    userRatingCount: details?.userRatingCount || place.userRatingCount || 0,
    lat: details?.location?.latitude || place.lat || null,
    lng: details?.location?.longitude || place.lng || null
  };
  placeDetailsCache.set(cacheKey, enriched);
  if (enriched.googlePlaceId && enriched.googlePlaceId !== cacheKey) {
    placeDetailsCache.set(enriched.googlePlaceId, enriched);
  }
  return enriched;
}

function showDetail(index) {
  const trip = state.latestTrip;
  const place = trip.places[index];
  state.activeIndex = index;
  renderGoogleMap(trip);
  renderDetailModal(place, { leg: trip.legs[index] });
}

function updateHash(trip) {
  const payload = {
    d: trip.destination,
    cities: state.cities,
    hotels: trip.hotelAreas.map((hotel, index) => ({
      city: hotel.city,
      id: hotel.id,
      areaId: hotel.id,
      label: hotel.label,
      lat: hotel.lat || null,
      lng: hotel.lng || null,
      transferMode: hotel.transferMode || state.cityTransferModes[index] || "train"
    })),
    n: nationalityInput.value,
    day: trip.days,
    min: trip.budgetMin,
    max: trip.budgetMax,
    discovery: trip.discoveryMode ? "on" : "off",
    transport: trip.transportMode,
    country: trip.country,
    stars: trip.hotelStars,
    lang: state.language,
    travelerCount: travelerCountInput?.value,
    airport: state.departureAirport,
    flight: state.flightDepartureTime,
    flightTime: state.flightDepartureTime,
    arrivalAirport: state.arrivalAirport,
    arrivalTime: state.flightArrivalTime,
    cityTransferModes: state.cityTransferModes,
    travelers: travelers.map((traveler) => ({
      vibes: traveler.vibes,
      mustVisits: traveler.mustVisits
    }))
  };
  window.history.replaceState(null, "", `#${encodeURIComponent(JSON.stringify(payload))}`);
}

function restoreFromHash() {
  if (!location.hash) return;

  try {
    const payload = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    countryInput.value = payload.country || inferCountryForCity(payload.d || destinationInput.value);
    state.countryCode = countryCodeByName[normalizeCountryName(countryInput.value)] || state.countryCode || "";
    renderCountryTag();
    updateCityAutocompleteRestriction();
    if (Array.isArray(payload.cities)) {
      state.cities = payload.cities;
    } else {
      state.cities = [payload.d || countryCities[countryInput.value]?.[0] || "Tokyo"];
    }
    renderCityTags();
    if (payload.n) nationalityInput.value = payload.n;
    if (payload.day) daysInput.value = payload.day;
    const savedHotels = Array.isArray(payload.hotels)
      ? payload.hotels
      : Array.from({ length: Math.max(0, Number(payload.day || daysInput.value || 1) - 1) }, () => ({ city: state.cities[0], areaId: payload.a })).filter((item) => item.areaId);
    renderAccommodationOptions(savedHotels);
    if (payload.min) budgetMinInput.value = payload.min;
    if (payload.max) budgetMaxInput.value = payload.max;
    if (payload.travelerCount && travelerCountInput) {
      travelerCountInput.value = payload.travelerCount;
    }
    if (payload.discovery) discoveryModeInput.value = payload.discovery;
    if (payload.transport) transportModeInput.value = payload.transport;
    if (payload.stars) hotelStarsInput.value = payload.stars;
    if (payload.airport) {
      state.departureAirport = payload.airport;
      if (departureAirportInput) departureAirportInput.value = payload.airport;
    }
    if (payload.flightTime) {
      state.flightDepartureTime = payload.flightTime;
      if (flightDepTimeInput) flightDepTimeInput.value = payload.flightTime;
    } else if (payload.flight) {
      state.flightDepartureTime = payload.flight;
      if (flightDepTimeInput) flightDepTimeInput.value = payload.flight;
    }
    if (payload.arrivalAirport) {
      state.arrivalAirport = payload.arrivalAirport;
      if (arrivalAirportInput) arrivalAirportInput.value = payload.arrivalAirport;
    }
    if (payload.arrivalTime) {
      state.flightArrivalTime = payload.arrivalTime;
      if (flightArrivalTimeInput) flightArrivalTimeInput.value = payload.arrivalTime;
    }
    if (payload.cityTransferModes && typeof payload.cityTransferModes === "object") {
      state.cityTransferModes = payload.cityTransferModes;
      renderAccommodationOptions(savedHotels);
    }
    if (payload.lang && i18n[payload.lang]) {
      state.language = payload.lang;
      applyLanguage();
    }
    if (Array.isArray(payload.travelers)) {
      payload.travelers.forEach((item, index) => {
        if (!travelers[index]) return;
        if (Array.isArray(item.vibes)) travelers[index].vibes = item.vibes;
        if (Array.isArray(item.mustVisits)) travelers[index].mustVisits = item.mustVisits.slice(0, 3);
        while (travelers[index].mustVisits.length < 3) travelers[index].mustVisits.push("");
      });
    }
    renderTravelers();
  } catch {
    showToast("分享链接参数无法识别，已使用默认行程");
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 2200);
}

async function getSupabaseBrowserClient() {
  if (supabaseBrowserClient) return supabaseBrowserClient;
  const [{ createClient }, configRes] = await Promise.all([
    import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm"),
    fetch("/api/config")
  ]);
  const config = await configRes.json();
  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error("Supabase public env vars are not configured");
  }
  supabaseBrowserClient = createClient(config.supabaseUrl, config.supabaseKey);
  return supabaseBrowserClient;
}

function readTripFormState() {
  const days = Number(daysInput.value || 5);
  const plan = getActivePlan();
  return {
    destination: state.cities[0] || destinationInput.value,
    country: countryInput.value,
    cities: state.cities,
    days,
    budget_min: Number(budgetMinInput.value || 0),
    budget_max: Number(budgetMaxInput.value || 0),
    transport_mode: transportModeInput.value,
    hotel_stars: Number(hotelStarsInput.value || 3),
    flight_departure_time: state.flightDepartureTime,
    airport: state.departureAirport,
    flight_arrival_time: state.flightArrivalTime,
    arrival_airport: state.arrivalAirport,
    city_transfer_modes: state.cityTransferModes,
    departure_date: departureInput.value || null,
    hotel_areas: getHotelAreas(plan, days),
    language: state.language
  };
}

function travelerToMemberPayload(traveler, tripId, isPlanner = false) {
  return {
    trip_id: tripId,
    name: traveler.name,
    vibes: traveler.vibes,
    must_visits: traveler.mustVisits,
    budget: typeof traveler.budget === 'number'
      ? traveler.budget
      : parseInt(String(traveler.budget).replace(/[^0-9]/g, '')) *
        (String(traveler.budget).toLowerCase().includes('k') ? 1000 : 1) || 0,
    is_planner: isPlanner,
    filled_at: new Date().toISOString()
  };
}

async function persistGeneratedItinerary() {
  const tripId = sharedTripId || window._activeTripId || activeInviteTrip?.id;
  if (!tripId || !state.latestTrip) return;

  try {
    const supabase = await getSupabaseBrowserClient();
    const { error } = await supabase
      .from("trips")
      .update({ generated_itinerary: state.latestTrip })
      .eq("id", tripId);
    if (error) console.error(error);
  } catch (error) {
    console.error(error);
  }
}

function memberToTraveler(member, index) {
  const palette = ["#1c6b7a", "#d85d47", "#0f8f73", "#6c5ce7", "#f0a04b"];
  return {
    name: member.name || `Member ${index + 1}`,
    role: member.is_planner ? "Planner" : "Teammate",
    budget: member.budget || "",
    vibes: Array.isArray(member.vibes) ? member.vibes : [],
    mustVisits: normalizeMustVisits(member.must_visits),
    wishlist: Array.isArray(member.wishlist) ? member.wishlist : [],
    color: palette[index % palette.length]
  };
}

function syncWishlistFromMembers(members = []) {
  wishlistState.counts = new Map();
  wishlistState.mine = new Set();
  members.forEach((member) => {
    const wishlist = Array.isArray(member.wishlist) ? member.wishlist : [];
    const uniqueWishlist = new Set(wishlist.filter(Boolean));
    uniqueWishlist.forEach((placeId) => {
      wishlistState.counts.set(placeId, (wishlistState.counts.get(placeId) || 0) + 1);
      if (member.name === currentSharedMemberName) {
        wishlistState.mine.add(placeId);
      }
    });
  });
}

function syncTravelersFromMembers(members = []) {
  syncWishlistFromMembers(members);
  const nextTravelers = members.map(memberToTraveler);
  if (!nextTravelers.length) return;
  travelers.splice(0, travelers.length, ...nextTravelers);
  renderTravelers();
}

function getDemoTravelersForLocalTesting() {
  return demoTravelers.map((traveler) => ({
    ...traveler,
    vibes: [...traveler.vibes],
    mustVisits: [...traveler.mustVisits]
  }));
}

async function generateFromMembersOrDemo() {
  if (activeInviteTrip?.id) {
    const supabase = await getSupabaseBrowserClient();
    const { data: latestMembers, error: membersError } = await supabase
      .from("members")
      .select("*")
      .eq("trip_id", activeInviteTrip.id)
      .not("filled_at", "is", null)
      .order("created_at", { ascending: true });
    if (membersError) throw membersError;
    syncTravelersFromMembers(latestMembers || []);
    await generateTrip((latestMembers || []).map(memberToTraveler));
    if (activeMembersChannel && state.latestTrip) {
      activeMembersChannel.send({
        type: "broadcast",
        event: "itinerary",
        payload: state.latestTrip
      }).catch(console.error);
    }
    return;
  }
  await generateTrip(getDemoTravelersForLocalTesting());
}

function sharedMemberStorageKey(tripId) {
  return `wetrip_member_${tripId}`;
}

function sharedPlannerStorageKey(tripId) {
  return `wetrip_planner_${tripId}`;
}

function setSharedTripPermissions() {
  if (!sharedTripId) return;
  const canEditTrip = isSharedPlanner;
  const controls = [
    countryInput, destinationInput, cityAddSelect, cityAddBtn, daysInput,
    travelerCountInput, budgetMinInput, budgetMaxInput, discoveryModeInput,
    transportModeInput, hotelStarsInput, departureAirportInput, flightDepTimeInput,
    arrivalAirportInput, flightArrivalTimeInput,
    nationalityInput, departureInput, languageInput, applyHotelAll
  ].filter(Boolean);
  controls.forEach((control) => {
    control.disabled = !canEditTrip;
  });
  hotelAreaList?.querySelectorAll("select,input").forEach((control) => {
    control.disabled = !canEditTrip;
  });
  cityTags?.querySelectorAll("button").forEach((button) => {
    button.disabled = !canEditTrip;
  });
  if (shareButton) shareButton.style.display = "";
  if (regenerate) regenerate.style.display = canEditTrip ? "" : "none";
  form?.querySelector("button[type='submit']")?.style.setProperty("display", canEditTrip ? "" : "none");
}

async function saveSharedCurrentMember() {
  if (!sharedTripId || !currentSharedMemberName) return;
  const member = travelers.find((traveler) => traveler.name === currentSharedMemberName);
  if (!member) return;
  const supabase = await getSupabaseBrowserClient();
  const { error } = await supabase
    .from("members")
    .update({
      vibes: member.vibes,
      must_visits: member.mustVisits.map((item) => item.trim()).filter(Boolean),
      budget: typeof member.budget === "number" ? member.budget : parseInt(String(member.budget).replace(/[^0-9]/g, "")) || 0,
      filled_at: new Date().toISOString()
    })
    .eq("trip_id", sharedTripId)
    .ilike("name", currentSharedMemberName);
  if (error) console.error(error);
}

function scheduleSharedMemberSave() {
  if (!sharedTripId || !currentSharedMemberName) return;
  clearTimeout(memberSaveTimer);
  memberSaveTimer = setTimeout(() => {
    saveSharedCurrentMember().catch(console.error);
  }, 500);
}

function showIdentityModal(tripId, members = []) {
  const modal = document.createElement("div");
  modal.className = "invite-modal-backdrop";
  const options = members.map((member) => `
    <button class="secondary-button identity-pick" type="button" data-member-name="${member.name}">
      ${member.name}
    </button>
  `).join("");
  modal.innerHTML = `
    <div class="invite-modal" role="dialog" aria-modal="true">
      <p class="label">We-trip</p>
      <h3>${state.language === "en" ? "Who are you?" : "你是谁？"}</h3>
      <div class="identity-options">${options}</div>
      <div class="invite-link-row">
        <input class="identity-name-input" placeholder="${state.language === "en" ? "Enter a new name" : "输入新名字"}" />
        <button class="primary-button identity-new" type="button">${state.language === "en" ? "Continue" : "继续"}</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const identify = async (name, createIfMissing = false) => {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    const supabase = await getSupabaseBrowserClient();
    if (createIfMissing && !members.some((member) => String(member.name || "").toLowerCase() === cleanName.toLowerCase())) {
      const { error } = await supabase.from("members").insert({
        trip_id: tripId,
        name: cleanName,
        budget: Number(budgetMaxInput.value || 0),
        vibes: [],
        must_visits: ["", "", ""],
        filled_at: new Date().toISOString()
      });
      if (error) {
        showToast(error.message);
        return;
      }
    }
    currentSharedMemberName = cleanName;
    window.localStorage.setItem(sharedMemberStorageKey(tripId), cleanName);
    modal.remove();
    await renderInviteProgress(tripId);
    setSharedTripPermissions();
  };

  modal.querySelectorAll(".identity-pick").forEach((button) => {
    button.addEventListener("click", () => {
      identify(button.dataset.memberName, false).catch(console.error);
    });
  });
  modal.querySelector(".identity-new")?.addEventListener("click", () => {
    const input = modal.querySelector(".identity-name-input");
    identify(input?.value, true).catch(console.error);
  });
}

function showInviteModal(inviteUrl, tripId = null) {
  const modal = document.createElement("div");
  modal.className = "invite-modal-backdrop";
  modal.innerHTML = `
    <div class="invite-modal" role="dialog" aria-modal="true">
      <button class="icon-button invite-modal-close" type="button" aria-label="Close">×</button>
      <p class="label">${state.language === "en" ? "Invite link" : "邀请链接"}</p>
      <h3>${state.language === "en" ? "Share with teammates" : "分享给队友填写偏好"}</h3>
      <div class="invite-link-row">
        <input class="invite-link-input" readonly value="${inviteUrl}" />
        <button class="secondary-button invite-copy-button" type="button">${state.language === "en" ? "Copy" : "复制"}</button>
      </div>
      <button class="primary-button invite-go-button" type="button">
        ${state.language === "en" ? "Go to shared page" : "前往共享页面"}
      </button>
      <p class="muted">${state.language === "en" ? "Members can fill their own vibes and must-visit places asynchronously." : "队友可异步填写自己的氛围和必去地点。"}</p>
    </div>
  `;
  document.body.appendChild(modal);
  modal.querySelector(".invite-modal-close").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.remove();
  });
  modal.querySelector(".invite-copy-button").addEventListener("click", async () => {
    await navigator.clipboard.writeText(inviteUrl);
    showToast(state.language === "en" ? "Invite link copied" : "邀请链接已复制");
  });
  modal.querySelector(".invite-go-button")?.addEventListener("click", () => {
    window.location.href = tripId ? `/trip/${tripId}` : inviteUrl;
  });
}

async function renderInviteProgress(tripId) {
  const supabase = await getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from("members")
    .select("*")
    .eq("trip_id", tripId)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const members = data || [];
  syncTravelersFromMembers(members);
  setSharedTripPermissions();
  if (state.latestTrip) renderReservePool(state.latestTrip);
}

async function subscribeInviteProgress(tripId) {
  window._activeTripId = tripId;
  const supabase = await getSupabaseBrowserClient();
  if (activeMembersChannel) {
    await supabase.removeChannel(activeMembersChannel);
    activeMembersChannel = null;
  }
  activeMembersChannel = supabase
    .channel(`members-trip-${tripId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "members",
      filter: `trip_id=eq.${tripId}`
    }, () => {
      renderInviteProgress(tripId).catch(console.error);
    })
    .on("broadcast", { event: "itinerary" }, ({ payload }) => {
      state.latestTrip = payload;
      renderTrip();
    })
    .subscribe();
  await renderInviteProgress(tripId);
}

function applyTripPayloadToForm(trip) {
  if (!trip) return;
  if (trip.country) {
    countryInput.value = trip.country;
    state.countryCode = countryCodeByName[normalizeCountryName(trip.country)] || state.countryCode || "";
    renderCountryTag();
    updateCityAutocompleteRestriction();
  }
  if (Array.isArray(trip.cities) && trip.cities.length) {
    state.cities = trip.cities;
  } else if (trip.destination) {
    state.cities = [trip.destination];
  }
  if (destinationInput && state.cities[0]) destinationInput.value = state.cities[0];
  renderCityTags();
  if (trip.days) daysInput.value = trip.days;
  if (trip.budget_min !== undefined) budgetMinInput.value = trip.budget_min;
  if (trip.budget_max !== undefined) budgetMaxInput.value = trip.budget_max;
  if (trip.transport_mode) transportModeInput.value = trip.transport_mode;
  if (trip.hotel_stars) hotelStarsInput.value = trip.hotel_stars;
  if (trip.flight_departure_time) {
    state.flightDepartureTime = trip.flight_departure_time;
    if (flightDepTimeInput) flightDepTimeInput.value = trip.flight_departure_time;
  }
  if (trip.airport) {
    state.departureAirport = trip.airport;
    if (departureAirportInput) departureAirportInput.value = trip.airport;
  }
  if (trip.arrival_airport || trip.arrivalAirport) {
    state.arrivalAirport = trip.arrival_airport || trip.arrivalAirport;
    if (arrivalAirportInput) arrivalAirportInput.value = state.arrivalAirport;
  }
  if (trip.flight_arrival_time || trip.flightArrivalTime) {
    state.flightArrivalTime = trip.flight_arrival_time || trip.flightArrivalTime;
    if (flightArrivalTimeInput) flightArrivalTimeInput.value = state.flightArrivalTime;
  }
  if (trip.city_transfer_modes || trip.cityTransferModes) {
    state.cityTransferModes = trip.city_transfer_modes || trip.cityTransferModes || {};
  }
  if (trip.language && i18n[trip.language]) {
    state.language = trip.language;
    if (languageInput) languageInput.value = trip.language;
    applyLanguage();
  }
  renderAccommodationOptions(Array.isArray(trip.hotel_areas) ? trip.hotel_areas : []);
  updateFlightTimeVisibility();
}

async function restoreInviteTripFromQuery() {
  const tripId = new URLSearchParams(window.location.search).get("trip_id");
  if (!tripId) return;
  const supabase = await getSupabaseBrowserClient();
  const { data: trip, error } = await supabase
    .from("trips")
    .select("*")
    .eq("id", tripId)
    .single();
  if (error) throw error;
  activeInviteTrip = trip;
  window._activeTripId = tripId;
  applyTripPayloadToForm(trip);
  await subscribeInviteProgress(tripId);
}

async function loadSharedTrip(tripId) {
  sharedTripId = tripId;
  window._activeTripId = tripId;
  const storedMemberName = window.localStorage.getItem(sharedMemberStorageKey(tripId));
  isSharedPlanner = window.localStorage.getItem(sharedPlannerStorageKey(tripId)) === "true";
  currentSharedMemberName = storedMemberName || null;
  const supabase = await getSupabaseBrowserClient();
  const { data: trip, error } = await supabase
    .from("trips")
    .select("*")
    .eq("id", tripId)
    .single();
  if (error) throw error;
  activeInviteTrip = trip;
  applyTripPayloadToForm(trip);
  if (trip.generated_itinerary) {
    state.latestTrip = trip.generated_itinerary;
    state.activeIndex = 0;
  }
  const { data: members, error: membersError } = await supabase
    .from("members")
    .select("*")
    .eq("trip_id", tripId)
    .order("created_at", { ascending: true });
  if (membersError) throw membersError;
  syncTravelersFromMembers(members || []);
  setSharedTripPermissions();
  if (state.latestTrip) renderTrip();
  await subscribeInviteProgress(tripId);
  if (!storedMemberName) {
    showIdentityModal(tripId, members || []);
  }
}

async function createInviteTrip() {
  const supabase = await getSupabaseBrowserClient();
  const tripPayload = readTripFormState();
  const { data: trip, error: tripError } = await supabase
    .from("trips")
    .insert(tripPayload)
    .select("*")
    .single();
  if (tripError) throw tripError;

  const planner = travelers[0];
  const { error: memberError } = await supabase
    .from("members")
    .insert(travelerToMemberPayload(planner, trip.id, true));
  if (memberError) throw memberError;

  activeInviteTrip = trip;
  window._activeTripId = trip.id;
  currentSharedMemberName = planner.name;
  window.localStorage.setItem(sharedPlannerStorageKey(trip.id), "true");
  window.localStorage.setItem(sharedMemberStorageKey(trip.id), planner.name);
  const inviteUrl = `${window.location.origin}/trip/${trip.id}`;
  showInviteModal(inviteUrl, trip.id);
  return trip;
}

destinationInput.addEventListener("change", () => {
  cityCentersCache = {};
  state.cities = [destinationInput.value];
  renderCityTags();
  renderAccommodationOptions();
  resetMustVisitsForDestination();
  renderTravelers();
  generateTrip();
});

countryInput.addEventListener("change", () => {
  setCountrySelection(countryInput.value, countryCodeByName[normalizeCountryName(countryInput.value)] || "");
});

countryInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  setCountrySelection(countryInput.value, countryCodeByName[normalizeCountryName(countryInput.value)] || "");
});

countryTags?.addEventListener("click", (event) => {
  const removeBtn = event.target.closest("[data-remove-country]");
  if (!removeBtn) return;
  countryInput.value = "";
  state.countryCode = "";
  state.cities = [];
  cityCentersCache = {};
  renderCountryTag();
  updateCityAutocompleteRestriction();
  renderCityTags();
  resetMustVisitsForDestination();
  renderTravelers();
  generateTrip().catch(console.error);
});

daysInput.addEventListener("change", () => {
  renderAccommodationOptions(Array.from({ length: Math.max(0, Number(daysInput.value || 1) - 1) }, (_, index) => {
    const city = hotelAreaList.querySelector(`.hotel-city-select[data-hotel-day="${index}"]`)?.value;
    const areaInput = hotelAreaList.querySelector(`.hotel-area-input[data-hotel-day="${index}"]`);
    const transferMode = hotelAreaList.querySelector(`.city-transfer-select[data-transfer-day="${index}"]`)?.value;
    return city || areaInput?.value ? {
      city,
      id: areaInput?.dataset.areaId || slugify(areaInput?.value || city),
      label: areaInput?.value || `${city} center`,
      lat: Number(areaInput?.dataset.lat) || null,
      lng: Number(areaInput?.dataset.lng) || null,
      transferMode
    } : null;
  }).filter(Boolean));
  generateTrip();
});
travelerCountInput?.addEventListener("change", generateTrip);

hotelAreaList.addEventListener("change", generateTrip);

cityTags?.addEventListener("click", (event) => {
  const removeBtn = event.target.closest("[data-remove-city]");
  if (!removeBtn) return;
  const city = removeBtn.dataset.removeCity;
  if (state.cities.length <= 1) return;
  state.cities = state.cities.filter((item) => item !== city);
  delete cityCentersCache[city];
  renderCityTags();
  resetMustVisitsForDestination();
  renderTravelers();
  generateTrip().catch(console.error);
});

cityAddBtn?.addEventListener("click", () => {
  const city = cityAddSelect?.value;
  addCityTag(city);
});

cityAddSelect?.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  addCityTag(cityAddSelect.value);
});

applyHotelAll.addEventListener("click", () => {
  const firstCity = hotelAreaList.querySelector(".hotel-city-select")?.value;
  const firstArea = hotelAreaList.querySelector(".hotel-area-input");
  if (!firstCity && !firstArea?.value) return;
  hotelAreaList.querySelectorAll(".hotel-city-select").forEach((select) => {
    select.value = firstCity;
  });
  hotelAreaList.querySelectorAll(".hotel-area-input").forEach((input) => {
    input.value = firstArea?.value || `${firstCity} center`;
    input.dataset.areaId = firstArea?.dataset.areaId || slugify(input.value);
    input.dataset.lat = firstArea?.dataset.lat || "";
    input.dataset.lng = firstArea?.dataset.lng || "";
  });
  updateCityTransferControls();
  generateTrip();
});
discoveryModeInput.addEventListener("change", generateTrip);
transportModeInput.addEventListener("change", generateTrip);
departureAirportInput.addEventListener("change", () => {
  state.departureAirport = departureAirportInput.value;
  updateFlightTimeVisibility();
  generateTrip();
});
flightDepTimeInput.addEventListener("change", () => {
  state.flightDepartureTime = flightDepTimeInput.value;
  generateTrip();
});
arrivalAirportInput?.addEventListener("change", () => {
  state.arrivalAirport = arrivalAirportInput.value;
  updateFlightTimeVisibility();
  generateTrip();
});
flightArrivalTimeInput?.addEventListener("change", () => {
  state.flightArrivalTime = flightArrivalTimeInput.value;
  generateTrip();
});
languageInput.addEventListener("change", () => {
  state.language = languageInput.value;
  applyLanguage();
  renderAccommodationOptions(getHotelAreas(getActivePlan(), Number(daysInput.value || 1)));
  renderTravelers();
  generateTrip();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  generateFromMembersOrDemo().catch(console.error);
});

regenerate.addEventListener("click", () => {
  travelers.forEach((traveler, index) => {
    const options = vibeOptions.map((item) => item[0]).filter((id) => !traveler.vibes.includes(id));
    if (options.length) traveler.vibes = [...traveler.vibes.slice(-2), options[(index + Date.now()) % options.length]];
  });
  renderTravelers();
  generateTrip();
  showToast("已基于同行者偏好重新合成路线");
});

async function exportTripPDF() {

  try {
    if (!window.html2canvas || !window.jspdf?.jsPDF) {
      showToast(state.language === "zh" ? "PDF 工具加载中，请稍后再试" : "PDF tools are still loading. Try again soon.");
      return;
    }
    if (!state.latestTrip || !pdfExport) return;
    showToast(state.language === "zh" ? "生成中..." : "Generating...");
    pdfExport.innerHTML = buildPdfExportHtml(state.latestTrip);
    pdfExport.style.display = "block";
    pdfExport.style.position = "absolute";
    pdfExport.style.left = "-9999px";
    pdfExport.style.top = "0";
    const canvas = await window.html2canvas(pdfExport, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });
    pdfExport.style.display = "none";
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF("p", "mm", "a4");
    const imgWidth = 210;
    const imgHeight = canvas.height * imgWidth / canvas.width;
    let position = 0;
    const pageHeight = 297;
    while (position < imgHeight) {
      pdf.addImage(canvas, "PNG", 0, -position, imgWidth, imgHeight);
      position += pageHeight;
      if (position < imgHeight) pdf.addPage();
    }
    const destination = state.latestTrip?.destination || "trip";
    const date = new Date().toISOString().slice(0, 10);
    pdf.save(`wetrip-${destination}-${date}.pdf`);
  } catch (error) {
    console.error(error);
    if (pdfExport) pdfExport.style.display = "none";
    showToast(state.language === "zh" ? "PDF 导出失败" : "PDF export failed");
  }
}

function buildPdfExportHtml(trip) {
  const isEn = state.language === "en";
  const hotelSummary = summarizeHotelAreas(trip.hotelAreas);
  const travelersCount = travelers.length || trip.costBreakdown?.travelerCount || 1;
  const destinationLabel = escapeHtml((trip.cities?.length ? trip.cities.join(" + ") : trip.destination) || trip.plan?.label || "");
  const countryLabel = escapeHtml(t("countryNames")[trip.country] || trip.country || "");
  const departureDate = formatPdfDate(departureInput.value);
  const nights = Math.max(0, trip.days - 1);
  const hotelStars = trip.hotelStars || Number(hotelStarsInput.value || 3);
  const budgetMin = trip.budgetMin ?? Number(budgetMinInput.value || 0);
  const budgetMax = trip.budgetMax ?? Number(budgetMaxInput.value || 0);
  const disclaimer = isEn
    ? "* All times are in local time · All prices are in USD and for reference only"
    : "* 所有时间均为当地时间 · 所有价格以美元（USD）计算，仅供参考";
  const divider = `<div style="border-top:1px solid #dfe7e4;margin:14px 0"></div>`;
  const membersHtml = travelers.map((traveler) => {
    const vibeNames = (traveler.vibes || [])
      .map((id) => vibeOptions.find((item) => item[0] === id)?.[state.language === "en" ? 0 : 1] || id)
      .join(isEn ? ", " : "、");
    const mustVisits = normalizeMustVisits(traveler.mustVisits || [])
      .filter(Boolean)
      .map(escapeHtml)
      .join(" / ");
    return `
      <div style="font-size:12px;color:#555;line-height:1.55;margin:7px 0 0">
        <div><strong style="color:#25322f">• ${escapeHtml(traveler.name || (isEn ? "Traveler" : "成员"))}</strong>${vibeNames ? ` — ${escapeHtml(vibeNames)}` : ""}</div>
        ${mustVisits ? `<div style="padding-left:12px">${isEn ? "Want to visit" : "想去"}: ${mustVisits}</div>` : ""}
      </div>
    `;
  }).join("");
  const summaryHtml = `
    <section style="margin:16px 0 18px">
      <div style="font-size:16px;font-weight:900;color:#1c6b7a;margin-bottom:8px">
        WE-TRIP · ${isEn ? "Group Travel Planning Assistant" : "多人旅行规划助手"}
      </div>
      ${divider}
      <div style="display:grid;gap:5px;font-size:12px;color:#555;line-height:1.5">
        <div><strong style="color:#25322f">${isEn ? "Destination" : "目的地"}:</strong> ${destinationLabel}${countryLabel ? `, ${countryLabel}` : ""}</div>
        <div><strong style="color:#25322f">${isEn ? "Travel dates" : "出行日期"}:</strong> ${departureDate} · ${trip.days}${isEn ? " days" : "天"}${nights}${isEn ? " nights" : "晚"}</div>
        <div><strong style="color:#25322f">${isEn ? "Travelers" : "出行人数"}:</strong> ${travelersCount}${isEn ? " travelers" : "人"} · ${hotelStars}★${isEn ? " hotel" : "酒店"}</div>
        <div><strong style="color:#25322f">${isEn ? "Budget range" : "预算范围"}:</strong> $${budgetMin} - $${budgetMax} /${isEn ? "person" : "人"}</div>
        <div><strong style="color:#25322f">${isEn ? "Overall score" : "综合评分"}:</strong> ${trip.algorithm?.averageScore || 0}/100 · ${isEn ? "Route travel" : "路线交通"}: ${trip.algorithm?.routeMinutes || 0} min</div>
      </div>
      ${divider}
      <div style="font-size:13px;font-weight:900;color:#1c6b7a;margin-bottom:4px">${isEn ? "Team members" : "团队成员"}:</div>
      ${membersHtml || `<div style="font-size:12px;color:#888">${isEn ? "No members listed." : "暂无成员信息。"}</div>`}
      ${divider}
    </section>
  `;
  const usageGuideHtml = `
    <section style="padding:18px 0 0;border-top:2px solid #eef3f1;break-inside:avoid">
      <h2 style="margin:0 0 8px;color:#1c6b7a;font-size:18px;line-height:1.2">${isEn ? "About this itinerary" : "关于本行程"}</h2>
      <ul style="margin:0;padding-left:18px;font-size:12px;color:#666;line-height:1.65">
        <li>${isEn ? "All times are in local time" : "所有时间均为当地时间"}</li>
        <li>${isEn ? "All prices are in USD and for reference only" : "所有价格以美元（USD）计算，仅供参考"}</li>
        <li>${isEn ? "Hotel costs are estimates; actual prices vary by date and room type" : "酒店费用为估算值，实际价格因时间和房型而异"}</li>
        <li>${isEn ? "Transit times are estimates; check live Google Maps routes before departure" : "交通时间为估算值，建议出发前确认 Google Maps 实时路线"}</li>
        <li>${isEn ? "The itinerary is generated by WE-TRIP AI from team preferences and can be adjusted manually on the web" : "行程由 WE-TRIP AI 根据团队偏好自动生成，可在网页端手动调整"}</li>
        <li>${isEn ? "Visit wetrip.ai anytime to edit or regenerate the itinerary" : "访问 wetrip.ai 可随时修改行程或重新生成"}</li>
      </ul>
    </section>
  `;
  const daysHtml = trip.itineraryDays.map((day) => {
    const dayColor = DAY_COLORS[(day.day - 1) % DAY_COLORS.length];
    const stopsHtml = day.places.map((place, index) => {
      const leg = day.legs?.[index] || {};
      const description = escapeHtml(getPlaceDescription(place) || "");
      const summary = description
        ? `<div style="font-size:12px;color:#555;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:4px">${description}</div>`
        : "";
      const taxi = leg.taxiLabel ? `<span style="color:#666"> · ${escapeHtml(leg.taxiLabel)}</span>` : "";
      const landmark = isLandmarkPlace(place)
        ? `<span style="display:inline-block;margin-left:6px;padding:2px 6px;border-radius:999px;background:#f2f3f5;color:#777;font-size:10px;font-weight:700">🏛 ${isEn ? "Landmark" : "著名景点"}</span>`
        : "";
      return `
        <div style="display:flex;gap:12px;padding:12px 0;border-top:1px solid #edf0ef;background:#fff">
          <div style="width:24px;height:24px;border-radius:50%;background:${dayColor};color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;flex:0 0 auto">
            ${index + 1}
          </div>
          <div style="min-width:0;flex:1">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
              <div style="font-size:15px;font-weight:800;color:#18211f">${escapeHtml(place.name)}${landmark}</div>
              <div style="font-size:12px;font-weight:800;color:#1c6b7a;white-space:nowrap">${place.score || 0}/100</div>
            </div>
            ${summary}
            <div style="font-size:11px;color:#777;margin-top:5px">
              ${escapeHtml(leg.label || (isEn ? "Transit time pending" : "交通时间待计算"))}${taxi}
            </div>
          </div>
        </div>
      `;
    }).join("");
    return `
      <section style="padding:18px 0;border-top:2px solid #eef3f1;break-inside:avoid">
        <h2 style="margin:0 0 4px;color:#1c6b7a;font-size:18px;line-height:1.2">
          Day ${day.day}
        </h2>
        <div style="font-size:12px;color:#666;margin-bottom:8px">
          ${escapeHtml(day.hotel?.label || "")} · ${day.routeMinutes || 0} min · $${day.cost || 0}
        </div>
        ${stopsHtml || `<div style="font-size:12px;color:#888;padding:10px 0">${isEn ? "No stops scheduled." : "当天不安排行程。"}</div>`}
      </section>
    `;
  }).join("");

  return `
    <div style="background:#fff;color:#17211f;font-family:Arial,'Microsoft YaHei',sans-serif">
      <header style="display:flex;align-items:center;gap:12px;margin-bottom:12px">
        <div style="width:54px;height:40px;border-radius:999px;background:#1c6b7a;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900">
          We
        </div>
        <div>
          <div style="font-size:25px;font-weight:900;color:#1c6b7a;letter-spacing:0">WE-TRIP</div>
          <div style="font-size:12px;color:#777">
            ${escapeHtml(trip.plan?.label || trip.destination || "")} · ${trip.days} ${isEn ? "days" : "天"} · ${escapeHtml(hotelSummary)} · ${travelersCount} ${isEn ? "travelers" : "人"}
          </div>
        </div>
      </header>
      <p style="font-size:11px;color:#888;margin:4px 0 16px">${disclaimer}</p>
      ${summaryHtml}
      ${daysHtml}
      ${usageGuideHtml}
    </div>
  `;
}

function formatPdfDate(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escapeHtml(value);
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

exportPdfButton?.addEventListener("click", () => {
  exportTripPDF().catch(console.error);
});

itineraryList.addEventListener("click", (event) => {
  const removeButton = event.target.closest(".stop-remove-btn");
  if (removeButton) {
    event.preventDefault();
    event.stopPropagation();
    removeItineraryStop(
      Number(removeButton.dataset.removeDay),
      Number(removeButton.dataset.removeStop)
    ).catch(console.error);
    return;
  }

  const card = event.target.closest("[data-index]");
  if (!card) return;
  showDetail(Number(card.dataset.index));
});

document.addEventListener("click", async (event) => {
  const wishlistButton = event.target.closest(".reserve-wishlist-btn");
  if (wishlistButton) {
    event.preventDefault();
    event.stopPropagation();
    await toggleReserveWishlist(wishlistButton.dataset.wishlistId);
    return;
  }

  const addButton = event.target.closest(".reserve-add-btn");
  if (addButton) {
    event.preventDefault();
    event.stopPropagation();
    const trip = state.latestTrip;
    const place = (trip?.allCandidates || [])
      .find((candidate) => candidate.id === addButton.dataset.addId);
    if (place) showAddToItineraryModal(place);
    return;
  }

  const card = event.target.closest(".reserve-card");
  if (!card) return;

  const lat = parseFloat(card.dataset.lat);
  const lng = parseFloat(card.dataset.lng);
  const id = card.dataset.reserveId;

  document.querySelectorAll(".reserve-card")
    .forEach((item) => item.classList.remove("active"));
  card.classList.add("active");

  const trip = state.latestTrip;
  const place = (trip?.allCandidates || [])
    .find((candidate) => candidate.id === id);
  if (!place) return;

  if (googleMap && window.google && !Number.isNaN(lat) && !Number.isNaN(lng)) {
    const position = { lat, lng };
    googleMap.panTo(position);
    googleMap.setZoom(15);

    if (window._reservePreviewMarker) {
      window._reservePreviewMarker.setMap(null);
    }

    window._reservePreviewMarker = new google.maps.Marker({
      position,
      map: googleMap,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 14,
        fillColor: "#94a3b8",
        fillOpacity: 0.9,
        strokeColor: "white",
        strokeWeight: 2
      },
      label: {
        text: "?",
        color: "white",
        fontWeight: "bold",
        fontSize: "12px"
      },
      title: card.querySelector(".reserve-card-name")?.textContent || ""
    });
  }

  renderDetailModal(place, {
    kicker: state.language === "en" ? "Reserve candidate" : "备选地点"
  });
  const enriched = await fetchReservePlaceDetails(place);
  if (enriched) {
    Object.assign(place, enriched);
    renderDetailModal(enriched, {
      kicker: state.language === "en" ? "Reserve candidate" : "备选地点"
    });
  }
});

closeDialog.addEventListener("click", () => dialog.close());

console.log("app.js loaded");
console.log("travelerList at load time:", document.querySelector("#traveler-list"));

init();
