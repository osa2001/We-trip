// ============ API HELPERS ============

let googleMap = null;
let mapMarkers = [];
let mapPolylines = [];

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
    apiPlace.location.longitude
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
    const allTypes = [...new Set(
      vibes.flatMap((v) => (vibeToPlaceTypes[v] || "tourist_attraction").split(","))
    )].slice(0, 5).join(",");

    const res = await fetch(
      `/api/places?type=recommendations` +
      `&lat=${cityCenter.lat}&lng=${cityCenter.lng}` +
      `&includedTypes=${encodeURIComponent(allTypes)}` +
      `&destination=${encodeURIComponent(city || state.latestTrip?.destination || "")}`
    );
    const data = await res.json();
    if (!data.places) return [];

    // 过滤质量
    return data.places
      .filter((p) => {
        const minCount = getMinRatingCount(city || state.latestTrip?.destination || "");
        return p.rating >= 4.0 && p.userRatingCount >= minCount;
      })
      .slice(0, 12)
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

// 获取真实交通时间（调用 /api/routes）
async function fetchTravelMatrix(places, hotelAreas) {
  void hotelAreas;
  if (!places.length) return null;
  try {
    // 需要真实 GPS 坐标才能调用
    // 暂时返回 null，用现有距离估算作为 fallback
    return null;
  } catch {
    return null;
  }
}
void fetchTravelMatrix;

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

const countryCities = {
  Japan: ["Tokyo", "Osaka", "Kyoto", "Hiroshima", "Nara", "Sapporo", "Fukuoka", "Yokohama", "Kamakura", "Nikko"],
  England: ["London", "Manchester", "Birmingham", "Edinburgh", "Liverpool", "Bristol", "Brighton", "Oxford", "Cambridge", "Bath"],
  France: ["Paris", "Nice", "Lyon", "Marseille", "Bordeaux", "Strasbourg", "Toulouse", "Cannes", "Mont Saint-Michel", "Versailles"],
  Germany: ["Berlin", "Munich", "Hamburg", "Frankfurt", "Cologne", "Dresden", "Heidelberg", "Stuttgart", "Nuremberg", "Düsseldorf"],
  Spain: ["Barcelona", "Madrid", "Seville", "Valencia", "Granada", "Bilbao", "Toledo", "Salamanca", "San Sebastián", "Málaga"],
  Italy: ["Rome", "Florence", "Venice", "Milan", "Naples", "Amalfi Coast", "Cinque Terre", "Bologna", "Siena", "Verona"],
  Norway: ["Oslo", "Bergen", "Tromsø", "Stavanger", "Trondheim", "Ålesund", "Flåm", "Geirangerfjord", "Lofoten", "Kristiansand"],
  Finland: ["Helsinki", "Rovaniemi", "Tampere", "Turku", "Oulu", "Lappeenranta", "Espoo", "Porvoo", "Savonlinna", "Inari"],
  USA: ["New York City", "Los Angeles", "San Francisco", "Las Vegas", "Miami", "Chicago", "New Orleans", "Seattle", "Washington DC", "Honolulu"]
};

const cityAreas = {
  Tokyo: [
    ["shibuya", "涩谷 / Shibuya", 55, 48],
    ["ginza", "银座 / Ginza", 70, 33],
    ["shinjuku", "新宿 / Shinjuku", 38, 65],
    ["ueno", "上野 / Ueno", 47, 24]
  ],
  Kyoto: [
    ["gion", "祇园 / Gion", 62, 48],
    ["kawaramachi", "河原町 / Kawaramachi", 55, 52],
    ["arashiyama", "嵐山 / Arashiyama", 22, 45],
    ["kyoto-station", "京都站 / Kyoto Station", 52, 68],
    ["kinkakuji", "北山 / Kinkakuji", 38, 28]
  ],
  Osaka: [
    ["namba", "难波 / Namba", 52, 62],
    ["umeda", "梅田 / Umeda", 48, 38],
    ["dotonbori", "道顿堀 / Dotonbori", 54, 58],
    ["tennoji", "天王寺 / Tennoji", 56, 72],
    ["shinsekai", "新世界 / Shinsekai", 55, 68]
  ],
  London: [
    ["west-end", "中心 / West End", 45, 42],
    ["south-bank", "南岸 / South Bank", 52, 52],
    ["shoreditch", "东区 / Shoreditch", 62, 38],
    ["notting-hill", "诺丁山 / Notting Hill", 32, 40],
    ["greenwich", "格林威治 / Greenwich", 68, 58]
  ],
  Paris: [
    ["marais", "玛黑区 / Le Marais", 46, 38],
    ["left-bank", "左岸 / Left Bank", 39, 56],
    ["opera", "歌剧院 / Opéra", 51, 44],
    ["montmartre", "蒙马特 / Montmartre", 54, 70]
  ],
  Berlin: [
    ["mitte", "米特 / Mitte", 52, 42],
    ["prenzlauer", "普伦茨劳贝格 / Prenzlauer Berg", 58, 32],
    ["kreuzberg", "克罗伊茨贝格 / Kreuzberg", 54, 58],
    ["charlottenburg", "夏洛滕堡 / Charlottenburg", 32, 40],
    ["friedrichshain", "弗里德里希斯海因 / Friedrichshain", 65, 48]
  ],
  Rome: [
    ["historic-center", "历史中心 / Historic Center", 52, 48],
    ["vatican", "梵蒂冈 / Vatican", 38, 42],
    ["trastevere", "特拉斯提弗列 / Trastevere", 44, 58],
    ["spanish-steps", "西班牙广场 / Spanish Steps", 50, 38],
    ["ostia", "奥斯蒂亚 / Ostia", 22, 72]
  ],
  Barcelona: [
    ["gothic", "哥特区 / Gothic Quarter", 55, 52],
    ["gracia", "格拉西亚 / Gràcia", 52, 38],
    ["barceloneta", "巴塞罗内塔 / Barceloneta", 65, 58],
    ["montjuic", "蒙特惠奇 / Montjuïc", 42, 65],
    ["poblenou", "波布雷诺 / Poblenou", 68, 52]
  ],
  Oslo: [
    ["center", "中心 / City Center", 52, 48],
    ["grunerlokka", "格吕内洛卡 / Grünerløkka", 56, 38],
    ["frogner", "弗罗格纳 / Frogner", 42, 42],
    ["gronland", "格伦兰 / Grønland", 58, 52],
    ["bygdoy", "比格达伊 / Bygdøy", 35, 52]
  ],
  Helsinki: [
    ["center", "中心 / City Center", 52, 48],
    ["kallio", "卡利奥 / Kallio", 58, 38],
    ["kanavansatama", "卡纳瓦萨里 / Kanavasatama", 62, 52],
    ["toolo", "图洛 / Töölö", 46, 38],
    ["west-harbor", "西港 / West Harbor", 38, 52]
  ],
  "New York City": [
    ["midtown", "曼哈顿中城 / Midtown", 52, 45],
    ["downtown", "下城 / Downtown", 52, 62],
    ["brooklyn", "布鲁克林 / Brooklyn", 60, 58],
    ["upper-west", "上西区 / Upper West Side", 48, 32],
    ["harlem", "哈莱姆 / Harlem", 50, 25]
  ],
  "Los Angeles": [
    ["hollywood", "好莱坞 / Hollywood", 38, 42],
    ["santa-monica", "圣莫尼卡 / Santa Monica", 22, 52],
    ["downtown-la", "市中心 / Downtown", 52, 55],
    ["beverly-hills", "贝弗利山 / Beverly Hills", 30, 46],
    ["silverlake", "银湖 / Silver Lake", 48, 48]
  ],
  "San Francisco": [
    ["union-square", "联合广场 / Union Square", 50, 48],
    ["mission", "教会区 / Mission", 48, 58],
    ["haight", "海特 / Haight-Ashbury", 38, 52],
    ["fishermans-wharf", "渔人码头 / Fisherman's Wharf", 45, 35],
    ["nob-hill", "诺布山 / Nob Hill", 48, 42]
  ]
};

function getAreasForCity(city) {
  return cityAreas[city] || [
    ["center", `${city} Center`, 50, 50],
    ["north", `${city} North`, 50, 30],
    ["south", `${city} South`, 50, 70],
    ["east", `${city} East`, 70, 50]
  ];
}

const hotelCostUSD = { 1: 40, 2: 70, 3: 110, 4: 180, 5: 320 };
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

const destinationPlans = {
  Tokyo: {
    label: "东京，日本",
    visaDays: { CN: 12, SG: 0, US: 0, MY: 0 },
    center: "涩谷 - 代官山 - 清澄白河",
    areas: [
      ["shibuya", "涩谷 / 表参道", 55, 48],
      ["ginza", "银座 / 东京站", 70, 33],
      ["shinjuku", "新宿", 38, 65],
      ["ueno", "上野 / 浅草", 47, 24]
    ],
    places: [
      ["清澄白河咖啡街", "slow-cafe", 32, 23, 42, "步行 18 分钟", "从精品咖啡开始，把旅行节奏压低。", "https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=900&q=82"],
      ["根津美术馆", "museum", 48, 33, 56, "公交 22 分钟", "庭园、展陈与安静茶室适合审美建模。", "https://images.unsplash.com/photo-1528360983277-13d401cdc186?auto=format&fit=crop&w=900&q=82"],
      ["代官山 T-Site", "architecture", 61, 46, 68, "步行 14 分钟", "书店、生活方式和建筑立面很适合午后。", "https://images.unsplash.com/photo-1521587760476-6c12a4b040da?auto=format&fit=crop&w=900&q=82"],
      ["中目黑河岸", "nature", 54, 62, 34, "步行 19 分钟", "低密度散步路线，适合作为当天缓冲。", "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?auto=format&fit=crop&w=900&q=82"],
      ["新宿黄金街", "night", 38, 70, 74, "地铁 25 分钟", "夜间分支点，适合小酒馆和深夜食堂。", "https://images.unsplash.com/photo-1542051841857-5f90071e7989?auto=format&fit=crop&w=900&q=82"],
      ["筑地场外市场", "local-food", 72, 27, 58, "地铁 21 分钟", "把早餐预算花在高确定性的本地烟火。", "https://images.unsplash.com/photo-1553621042-f6e147245754?auto=format&fit=crop&w=900&q=82"]
    ]
  },
  Seoul: {
    label: "首尔，韩国",
    visaDays: { CN: 10, SG: 0, US: 0, MY: 0 },
    center: "圣水 - 北村 - 汉南",
    areas: [
      ["hongdae", "弘大 / 延南", 35, 57],
      ["myeongdong", "明洞 / 钟路", 55, 42],
      ["seongsu", "圣水", 30, 35],
      ["gangnam", "江南", 66, 63]
    ],
    places: [
      ["圣水洞咖啡仓库", "slow-cafe", 27, 36, 38, "步行 12 分钟", "由工业空间改造出的慢节奏据点。", "https://images.unsplash.com/photo-1514933651103-005eec06c04b?auto=format&fit=crop&w=900&q=82"],
      ["DDP 东大门设计广场", "architecture", 61, 39, 46, "地铁 18 分钟", "曲线建筑和夜间灯光都很强。", "https://images.unsplash.com/photo-1538485399081-7191377e8241?auto=format&fit=crop&w=900&q=82"],
      ["北村韩屋村", "history", 50, 22, 24, "公交 26 分钟", "历史肌理清晰，适合轻步行。", "https://images.unsplash.com/photo-1534274867514-d5b47ef89ed7?auto=format&fit=crop&w=900&q=82"],
      ["汉南洞买手街", "shopping", 42, 58, 82, "地铁 20 分钟", "品牌店与餐厅密度高，预算弹性大。", "https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?auto=format&fit=crop&w=900&q=82"],
      ["广藏市场", "local-food", 70, 51, 44, "地铁 16 分钟", "小吃和传统市场组合，适合作为晚餐点。", "https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?auto=format&fit=crop&w=900&q=82"]
    ]
  },
  Bangkok: {
    label: "曼谷，泰国",
    visaDays: { CN: 0, SG: 0, US: 0, MY: 0 },
    center: "老城 - 河岸 - 暹罗",
    areas: [
      ["siam", "暹罗 / Chit Lom", 62, 54],
      ["riverside", "河岸", 35, 64],
      ["old-town", "老城", 38, 29],
      ["sukhumvit", "素坤逸", 72, 61]
    ],
    places: [
      ["郑王庙河岸", "history", 37, 26, 22, "船运 16 分钟", "城市记忆和河岸光线是第一站。", "https://images.unsplash.com/photo-1563492065599-3520f775eeed?auto=format&fit=crop&w=900&q=82"],
      ["Talat Noi 老街", "retro", 48, 43, 32, "步行 20 分钟", "复古机车、壁画和小店组成隐线。", "https://images.unsplash.com/photo-1508009603885-50cf7c579365?auto=format&fit=crop&w=900&q=82"],
      ["暹罗设计中心", "architecture", 63, 55, 61, "地铁 18 分钟", "室内设计、展览和购物都集中。", "https://images.unsplash.com/photo-1567748157439-651aca2ff064?auto=format&fit=crop&w=900&q=82"],
      ["唐人街夜市", "local-food", 72, 62, 48, "地铁 22 分钟", "预算友好的夜间烟火主线。", "https://images.unsplash.com/photo-1552465011-b4e21bf6e79a?auto=format&fit=crop&w=900&q=82"],
      ["湄南河日落船", "nature", 29, 69, 74, "船运 28 分钟", "用水路替代拥堵地面交通。", "https://images.unsplash.com/photo-1528181304800-259b08848526?auto=format&fit=crop&w=900&q=82"]
    ]
  },
  Paris: {
    label: "巴黎，法国",
    visaDays: { CN: 18, SG: 0, US: 0, MY: 0 },
    center: "玛黑 - 左岸 - 蒙马特",
    areas: [
      ["marais", "玛黑区", 46, 38],
      ["left-bank", "左岸 / 圣日耳曼", 39, 56],
      ["opera", "歌剧院 / 卢浮宫", 51, 44],
      ["montmartre", "蒙马特", 54, 70]
    ],
    places: [
      ["玛黑区画廊线", "museum", 41, 34, 64, "步行 15 分钟", "画廊、书店和咖啡店紧密连接。", "https://images.unsplash.com/photo-1502602898657-3e91760cbb34?auto=format&fit=crop&w=900&q=82"],
      ["圣日耳曼咖啡", "slow-cafe", 33, 54, 70, "地铁 17 分钟", "经典咖啡馆场景，但控制停留预算。", "https://images.unsplash.com/photo-1543349689-9a4d426bee8e?auto=format&fit=crop&w=900&q=82"],
      ["路易威登基金会", "architecture", 67, 31, 88, "公交 31 分钟", "建筑和展览强度高，适合核心锚点。", "https://images.unsplash.com/photo-1499856871958-5b9627545d1a?auto=format&fit=crop&w=900&q=82"],
      ["蒙马特日落", "nature", 54, 70, 35, "地铁 24 分钟", "用高处视野收束一天路线。", "https://images.unsplash.com/photo-1522093007474-d86e9bf7ba6f?auto=format&fit=crop&w=900&q=82"],
      ["圣旺跳蚤市场", "hidden", 73, 48, 52, "地铁 29 分钟", "小众淘物线，适合复古偏好。", "https://images.unsplash.com/photo-1519677100203-a0e668c92439?auto=format&fit=crop&w=900&q=82"]
    ]
  },
  London: {
    label: "伦敦，英国",
    visaDays: { CN: 21, SG: 0, US: 0, MY: 0 },
    center: "Soho - South Bank - Shoreditch",
    areas: [
      ["soho", "苏活 / 考文特花园", 48, 43],
      ["south-bank", "南岸 / 滑铁卢", 54, 55],
      ["shoreditch", "肖尔迪奇", 68, 35],
      ["kensington", "肯辛顿", 30, 50]
    ],
    places: [
      ["大英博物馆", "museum", 50, 36, 0, "地铁 14 分钟", "用世界级馆藏作为伦敦文化主锚点。", "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=900&q=82"],
      ["South Bank 河岸步道", "nature", 56, 56, 18, "步行 20 分钟", "泰晤士河景、剧场和街头表演组成低风险散步线。", "https://images.unsplash.com/photo-1529655683826-aba9b3e77383?auto=format&fit=crop&w=900&q=82"],
      ["Shoreditch 红砖街区", "retro", 69, 34, 38, "地铁 24 分钟", "涂鸦、古着和咖啡店适合小众探索。", "https://images.unsplash.com/photo-1505761671935-60b3a7427bad?auto=format&fit=crop&w=900&q=82"],
      ["Tate Modern", "museum", 58, 51, 0, "步行 18 分钟", "工业空间改造的现代艺术馆，适合文艺路线。", "https://images.unsplash.com/photo-1566127444979-b3d2b654e3d7?auto=format&fit=crop&w=900&q=82"],
      ["Borough Market", "local-food", 62, 58, 42, "步行 16 分钟", "高确定性的本地市场午餐点。", "https://images.unsplash.com/photo-1515669097368-22e68427d265?auto=format&fit=crop&w=900&q=82"],
      ["Covent Garden", "shopping", 49, 45, 64, "地铁 12 分钟", "剧院、生活方式店和餐厅密度高。", "https://images.unsplash.com/photo-1517394834181-95ed159986c7?auto=format&fit=crop&w=900&q=82"]
    ]
  },
  Berlin: {
    label: "柏林，德国",
    visaDays: { CN: 18, SG: 0, US: 0, MY: 0 },
    center: "Mitte - Kreuzberg - Prenzlauer Berg",
    areas: [
      ["mitte", "米特区", 52, 40],
      ["kreuzberg", "克罗伊茨贝格", 56, 62],
      ["prenzlauer", "普伦茨劳贝格", 60, 28],
      ["charlottenburg", "夏洛滕堡", 33, 47]
    ],
    places: [
      ["博物馆岛", "museum", 54, 38, 26, "步行 15 分钟", "多馆集中，适合作为历史和艺术的高权重锚点。", "https://images.unsplash.com/photo-1560969184-10fe8719e047?auto=format&fit=crop&w=900&q=82"],
      ["柏林墙东边画廊", "history", 67, 58, 0, "地铁 22 分钟", "城市记忆和街头艺术直接重叠。", "https://images.unsplash.com/photo-1587330979470-3595ac045ab0?auto=format&fit=crop&w=900&q=82"],
      ["Kreuzberg 咖啡街", "slow-cafe", 55, 63, 32, "步行 18 分钟", "咖啡馆、唱片店和运河边散步形成慢节奏半日线。", "https://images.unsplash.com/photo-1453614512568-c4024d13c247?auto=format&fit=crop&w=900&q=82"],
      ["包豪斯档案馆", "architecture", 42, 54, 18, "公交 24 分钟", "设计史和现代主义建筑偏好的精准匹配。", "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=82"],
      ["Markthalle Neun", "local-food", 58, 67, 36, "步行 14 分钟", "小吃摊和本地餐饮聚合，预算弹性好。", "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=900&q=82"],
      ["Klunkerkranich 天台", "night", 63, 75, 44, "地铁 26 分钟", "傍晚视野和音乐场景适合作为夜间收束点。", "https://images.unsplash.com/photo-1517457373958-b7bdd4587205?auto=format&fit=crop&w=900&q=82"]
    ]
  },
  Rome: {
    label: "罗马，意大利",
    visaDays: { CN: 18, SG: 0, US: 0, MY: 0 },
    center: "Centro Storico - Trastevere - Monti",
    areas: [
      ["centro", "历史中心", 52, 43],
      ["trastevere", "特拉斯提弗列", 43, 58],
      ["monti", "蒙蒂", 61, 47],
      ["prati", "普拉蒂 / 梵蒂冈", 35, 35]
    ],
    places: [
      ["斗兽场", "history", 63, 51, 18, "步行 17 分钟", "古罗马主叙事的最高识别度锚点。", "https://images.unsplash.com/photo-1552832230-c0197dd311b5?auto=format&fit=crop&w=900&q=82"],
      ["梵蒂冈博物馆", "museum", 31, 33, 34, "地铁 25 分钟", "艺术密度极高，适合作为半日核心。", "https://images.unsplash.com/photo-1531572753322-ad063cecc140?auto=format&fit=crop&w=900&q=82"],
      ["Trastevere 小巷", "local-food", 43, 59, 48, "步行 16 分钟", "餐馆、小广场和夜色都适合团队汇合。", "https://images.unsplash.com/photo-1529260830199-42c24126f198?auto=format&fit=crop&w=900&q=82"],
      ["万神殿周边", "architecture", 50, 42, 12, "步行 12 分钟", "建筑尺度和城市肌理适合低折返游览。", "https://images.unsplash.com/photo-1525874684015-58379d421a52?auto=format&fit=crop&w=900&q=82"],
      ["Villa Borghese", "nature", 47, 25, 20, "公交 21 分钟", "用公园和美术馆缓冲高密度古迹行程。", "https://images.unsplash.com/photo-1515542622106-78bda8ba0e5b?auto=format&fit=crop&w=900&q=82"],
      ["Monti 生活方式街区", "shopping", 60, 46, 58, "步行 14 分钟", "小店、古着和酒吧适合购物与夜间衔接。", "https://images.unsplash.com/photo-1523906834658-6e24ef2386f9?auto=format&fit=crop&w=900&q=82"]
    ]
  },
  Barcelona: {
    label: "巴塞罗那，西班牙",
    visaDays: { CN: 18, SG: 0, US: 0, MY: 0 },
    center: "Eixample - Gothic Quarter - Barceloneta",
    areas: [
      ["eixample", "扩展区", 52, 42],
      ["gothic", "哥特区", 48, 58],
      ["gracia", "格拉西亚", 47, 28],
      ["barceloneta", "巴塞罗那海滩", 63, 70]
    ],
    places: [
      ["圣家堂", "architecture", 57, 36, 30, "地铁 16 分钟", "高迪建筑主锚点，视觉确定性极强。", "https://images.unsplash.com/photo-1583422409516-2895a77efded?auto=format&fit=crop&w=900&q=82"],
      ["巴特罗之家", "architecture", 49, 42, 35, "步行 12 分钟", "立面、室内和城市步行线高度吻合。", "https://images.unsplash.com/photo-1539037116277-4db20889f2d4?auto=format&fit=crop&w=900&q=82"],
      ["哥特区小巷", "history", 47, 58, 16, "步行 15 分钟", "老城肌理清晰，适合穿插咖啡和小店。", "https://images.unsplash.com/photo-1511527661048-7fe73d85e9a4?auto=format&fit=crop&w=900&q=82"],
      ["博盖利亚市场", "local-food", 45, 57, 38, "步行 10 分钟", "本地小吃和市场动线适合作为午餐点。", "https://images.unsplash.com/photo-1543783207-ec64e4d95325?auto=format&fit=crop&w=900&q=82"],
      ["巴塞罗那海滩", "nature", 64, 72, 24, "公交 22 分钟", "用海风降低老城和建筑日的疲劳。", "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=900&q=82"],
      ["El Born 设计小店", "shopping", 53, 55, 54, "步行 14 分钟", "买手店、酒吧和画廊适合傍晚探索。", "https://images.unsplash.com/photo-1481437156560-3205f6a55735?auto=format&fit=crop&w=900&q=82"]
    ]
  },
  Oslo: {
    label: "奥斯陆，挪威",
    visaDays: { CN: 18, SG: 0, US: 0, MY: 0 },
    center: "Sentrum - Bjørvika - Grünerløkka",
    areas: [
      ["sentrum", "市中心", 50, 48],
      ["bjorvika", "Bjørvika 海湾", 61, 54],
      ["grunerlokka", "Grünerløkka", 45, 34],
      ["aker-brygge", "Aker Brygge", 39, 55]
    ],
    places: [
      ["奥斯陆歌剧院", "architecture", 62, 55, 0, "步行 14 分钟", "可步行屋顶和峡湾视野适合作为第一站。", "https://images.unsplash.com/photo-1513519245088-0e12902e5a38?auto=format&fit=crop&w=900&q=82"],
      ["Munch 美术馆", "museum", 64, 50, 18, "步行 12 分钟", "现代美术馆和海湾新区形成高效组合。", "https://images.unsplash.com/photo-1544531586-fde5298cdd40?auto=format&fit=crop&w=900&q=82"],
      ["Aker Brygge 海港", "luxury", 38, 56, 72, "电车 16 分钟", "海景餐厅和码头步道适合舒适预算线。", "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=82"],
      ["Grünerløkka 咖啡街", "slow-cafe", 45, 34, 34, "电车 18 分钟", "独立咖啡、唱片店和社区公园构成慢旅行片区。", "https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?auto=format&fit=crop&w=900&q=82"],
      ["Vigeland 雕塑公园", "nature", 27, 42, 0, "电车 25 分钟", "开阔公园和雕塑群适合家庭友好节奏。", "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=900&q=82"],
      ["Bygdøy 博物馆半岛", "history", 25, 63, 24, "公交 28 分钟", "海事、民俗和半岛自然合并成半日线。", "https://images.unsplash.com/photo-1527004013197-933c4bb611b3?auto=format&fit=crop&w=900&q=82"]
    ]
  },
  Helsinki: {
    label: "赫尔辛基，芬兰",
    visaDays: { CN: 18, SG: 0, US: 0, MY: 0 },
    center: "Kluuvi - Design District - Katajanokka",
    areas: [
      ["kluuvi", "Kluuvi 市中心", 52, 46],
      ["design", "设计区", 47, 58],
      ["katajanokka", "Katajanokka", 65, 48],
      ["kallio", "Kallio", 45, 30]
    ],
    places: [
      ["赫尔辛基中央图书馆 Oodi", "architecture", 50, 43, 0, "步行 12 分钟", "公共建筑和城市生活方式高度融合。", "https://images.unsplash.com/photo-1524758631624-e2822e304c36?auto=format&fit=crop&w=900&q=82"],
      ["阿黛浓美术馆", "museum", 53, 47, 22, "步行 10 分钟", "芬兰艺术入门点，适合文化密度控制。", "https://images.unsplash.com/photo-1564399579883-451a5d44ec08?auto=format&fit=crop&w=900&q=82"],
      ["设计区小店线", "shopping", 47, 59, 62, "步行 16 分钟", "家居、陶瓷和服装店构成清晰买手路线。", "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=900&q=82"],
      ["老市场大厅", "local-food", 59, 56, 36, "电车 12 分钟", "海港边的本地食物和轻午餐选择稳定。", "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=900&q=82"],
      ["Kallio 咖啡酒吧区", "slow-cafe", 45, 30, 32, "电车 18 分钟", "社区感强，适合从白天咖啡过渡到夜间酒吧。", "https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?auto=format&fit=crop&w=900&q=82"],
      ["Suomenlinna 海堡", "history", 70, 72, 18, "渡轮 25 分钟", "世界遗产海岛线，适合天气好的慢半日。", "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=82"]
    ]
  },
  "New York City": {
    label: "纽约，美国",
    visaDays: { CN: 30, SG: 0, US: 0, MY: 21 },
    center: "Lower Manhattan - Midtown - Brooklyn",
    areas: [
      ["midtown", "Midtown 曼哈顿", 54, 39],
      ["soho", "SoHo / 下城", 49, 61],
      ["williamsburg", "Williamsburg", 68, 58],
      ["upper-west", "Upper West Side", 40, 27]
    ],
    places: [
      ["MoMA 现代艺术博物馆", "museum", 54, 34, 30, "地铁 14 分钟", "现代艺术主锚点，适合高审美偏好用户。", "https://images.unsplash.com/photo-1485871981521-5b1fd3805eee?auto=format&fit=crop&w=900&q=82"],
      ["高线公园", "nature", 43, 50, 0, "地铁 18 分钟", "线性公园能把建筑、街区和步行连接起来。", "https://images.unsplash.com/photo-1490644658840-3f2e3f8c5625?auto=format&fit=crop&w=900&q=82"],
      ["SoHo 买手街", "shopping", 49, 62, 88, "步行 17 分钟", "品牌、画廊和咖啡店密度高，预算弹性大。", "https://images.unsplash.com/photo-1534270804882-6b5048b1c1fc?auto=format&fit=crop&w=900&q=82"],
      ["Williamsburg 咖啡与唱片", "retro", 69, 58, 46, "地铁 24 分钟", "复古店、音乐和河岸视野适合小众半日线。", "https://images.unsplash.com/photo-1518005020951-eccb494ad742?auto=format&fit=crop&w=900&q=82"],
      ["切尔西市场", "local-food", 44, 53, 48, "步行 12 分钟", "多人同行时非常稳妥的餐饮集合点。", "https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=900&q=82"],
      ["布鲁克林大桥夜景", "night", 59, 67, 0, "地铁 20 分钟", "免费但记忆点强，适合作为夜间收束路线。", "https://images.unsplash.com/photo-1518391846015-55a9cc003b25?auto=format&fit=crop&w=900&q=82"]
    ]
  },
  "Los Angeles": {
    label: "洛杉矶，美国",
    visaDays: { CN: 30, SG: 0, US: 0, MY: 21 },
    center: "Santa Monica - Hollywood - Downtown LA",
    areas: [
      ["santa-monica", "Santa Monica", 25, 58],
      ["hollywood", "Hollywood", 50, 39],
      ["dtla", "Downtown LA", 68, 55],
      ["silver-lake", "Silver Lake", 61, 43]
    ],
    places: [
      ["盖蒂中心", "museum", 32, 34, 25, "驾车 24 分钟", "建筑、展览和城市视野同时命中。", "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=82"],
      ["Griffith Observatory", "nature", 54, 30, 0, "驾车 25 分钟", "日落和城市夜景适合低成本高记忆点。", "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=82"],
      ["Arts District 画廊街", "hidden", 70, 57, 42, "驾车 18 分钟", "壁画、咖啡和独立店适合发现模式。", "https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=900&q=82"],
      ["Santa Monica Pier", "family", 23, 60, 38, "步行 16 分钟", "海边、游乐设施和餐饮对团队容错率高。", "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=900&q=82"],
      ["Silver Lake 咖啡线", "slow-cafe", 60, 43, 36, "驾车 16 分钟", "社区咖啡、唱片店和湖边散步节奏舒缓。", "https://images.unsplash.com/photo-1501339847302-ac426a4a7cbb?auto=format&fit=crop&w=900&q=82"],
      ["Rodeo Drive", "luxury", 36, 48, 95, "驾车 22 分钟", "高端购物和餐厅适合作为奢华偏好分支。", "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=900&q=82"]
    ]
  },
  "San Francisco": {
    label: "旧金山，美国",
    visaDays: { CN: 30, SG: 0, US: 0, MY: 21 },
    center: "Mission - Hayes Valley - Embarcadero",
    areas: [
      ["union-square", "Union Square", 52, 49],
      ["mission", "Mission District", 48, 66],
      ["hayes", "Hayes Valley", 42, 48],
      ["embarcadero", "Embarcadero", 65, 48]
    ],
    places: [
      ["SFMOMA", "museum", 55, 52, 30, "步行 14 分钟", "现代艺术和市中心路线衔接效率高。", "https://images.unsplash.com/photo-1501594907352-04cda38ebc29?auto=format&fit=crop&w=900&q=82"],
      ["Ferry Building 市集", "local-food", 66, 49, 46, "电车 12 分钟", "海湾边市场适合早餐或午餐集合。", "https://images.unsplash.com/photo-1504674900247-0877df9cc836?auto=format&fit=crop&w=900&q=82"],
      ["Mission 壁画街区", "hidden", 48, 67, 28, "地铁 18 分钟", "街头艺术、墨西哥餐和社区感适合深度线。", "https://images.unsplash.com/photo-1518005020951-eccb494ad742?auto=format&fit=crop&w=900&q=82"],
      ["Golden Gate Park", "nature", 24, 46, 18, "公交 28 分钟", "公园、美术馆和植物园能组成低风险半日。", "https://images.unsplash.com/photo-1448375240586-882707db888b?auto=format&fit=crop&w=900&q=82"],
      ["Hayes Valley 设计小店", "shopping", 42, 48, 58, "步行 15 分钟", "生活方式店和餐厅适合下午轻购物。", "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=900&q=82"],
      ["Twin Peaks 夜景", "night", 38, 62, 0, "驾车 20 分钟", "城市全景强，适合作为末段低成本记忆点。", "https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?auto=format&fit=crop&w=900&q=82"]
    ]
  }
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
const maxPerVibe = 2;
const minimumCandidatePool = 8;

const travelers = [
  { name: "Mia", role: "文化策展", budget: "$1.6k", vibes: ["museum", "architecture", "slow-cafe"], mustVisits: ["根津美术馆", "代官山 T-Site", "清澄白河咖啡街"], color: "#1c6b7a" },
  { name: "Alex", role: "美食探索", budget: "$2.1k", vibes: ["local-food", "night", "hidden"], mustVisits: ["筑地场外市场", "新宿黄金街", "中目黑河岸"], color: "#d85d47" },
  { name: "Jo", role: "低风险路线", budget: "$1.4k", vibes: ["family", "nature", "history"], mustVisits: ["中目黑河岸", "根津美术馆", "上野公园"], color: "#0f8f73" }
];
const defaultMustVisits = {
  Tokyo: [
    ["根津美术馆", "代官山 T-Site", "清澄白河咖啡街"],
    ["筑地场外市场", "新宿黄金街", "中目黑河岸"],
    ["中目黑河岸", "根津美术馆", "上野公园"]
  ],
  Seoul: [
    ["DDP 东大门设计广场", "北村韩屋村", "圣水洞咖啡仓库"],
    ["广藏市场", "汉南洞买手街", "圣水洞咖啡仓库"],
    ["北村韩屋村", "广藏市场", "汉江公园"]
  ],
  Bangkok: [
    ["郑王庙河岸", "Talat Noi 老街", "暹罗设计中心"],
    ["唐人街夜市", "湄南河日落船", "Talat Noi 老街"],
    ["郑王庙河岸", "暹罗设计中心", "伦披尼公园"]
  ],
  Paris: [
    ["玛黑区画廊线", "路易威登基金会", "圣日耳曼咖啡"],
    ["圣旺跳蚤市场", "圣日耳曼咖啡", "蒙马特日落"],
    ["蒙马特日落", "玛黑区画廊线", "卢森堡公园"]
  ]
};
const state = {
  latestTrip: null,
  activeIndex: 0,
  language: "zh",
  departureAirport: "UNKNOWN",
  flightDepartureTime: "14:00",
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
    nationality: "主预订人国籍",
    departure: "出发日期",
    language: "语言",
    hotelAreas: "每日酒店 / 住宿区域",
    applyAll: "全部套用",
    travelerPrefs: "每位同行者的氛围和必去地点",
    insight1: "跨国多人游用户手动协调数天",
    insight2: "竞品基准分析",
    insight3: "冷启动 4 周种子用户",
    generate: "合成团队行程",
    workspaceEyebrow: "多人行程优化",
    share: "邀请队友查看",
    personaLabel: "团队画像合成",
    algorithmLabel: "路线生成算法",
    budgetMonitor: "预算监控",
    modes: "步行 / 公交 / 驾车",
    consensusRoute: "共识路线",
    reservePool: "备选地点池",
    countryNames: { Japan: "日本", England: "英格兰", France: "法国", Germany: "德国", Spain: "西班牙", Italy: "意大利", Norway: "挪威", Finland: "芬兰", USA: "美国" },
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
    nationality: "Lead traveler nationality",
    departure: "Departure date",
    language: "Language",
    hotelAreas: "Hotel / accommodation area by day",
    applyAll: "Apply all",
    travelerPrefs: "Vibes and must-visit places per traveler",
    insight1: "International group travelers coordinate manually for days",
    insight2: "Competitor benchmarks",
    insight3: "Seed users in first 4 weeks",
    generate: "Generate group itinerary",
    workspaceEyebrow: "Group itinerary optimization",
    share: "Invite teammates",
    personaLabel: "Group profile synthesis",
    algorithmLabel: "Route generation algorithm",
    budgetMonitor: "Budget monitor",
    modes: "Walk / Transit / Drive",
    consensusRoute: "Consensus route",
    reservePool: "Reserve candidate pool",
    countryNames: { Japan: "Japan", England: "England", France: "France", Germany: "Germany", Spain: "Spain", Italy: "Italy", Norway: "Norway", Finland: "Finland", USA: "USA" },
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
const languageInput = document.querySelector("#language");
const title = document.querySelector("#workspace-title");
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
const shareButton = document.querySelector("#share");
const dialog = document.querySelector("#detail-dialog");
const closeDialog = document.querySelector("#close-dialog");
const detailImage = document.querySelector("#detail-image");
const detailKicker = document.querySelector("#detail-kicker");
const detailTitle = document.querySelector("#detail-title");
const detailBody = document.querySelector("#detail-body");
const toast = document.querySelector("#toast");

function init() {
  console.log("init() started");
  departureInput.valueAsDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 21);
  applyLanguage();
  renderCityOptions("Tokyo");
  renderCityTags();
  console.log("about to renderTravelers, travelerList:", travelerList);
  renderTravelers();
  console.log("travelerList element:", travelerList);
  bindTravelerListEvents();
  restoreFromHash();
  updateFlightTimeVisibility();
  // 等 Google Maps JS 加载完再初始化地图
  if (window.google) {
    initGoogleMap();
  } else {
    window.addEventListener("load", () => {
      initGoogleMap();
    });
  }
  generateTrip().catch(console.error);
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
      const placeIdx = Number(wrap.dataset.placeIdx);
      const placeName = suggestionItem.dataset.placeName;

      input.value = placeName;
      travelers[travelerIdx].mustVisits[placeIdx] = placeName;
      wrap.querySelector(".nomination-suggestions")
        .style.display = "none";
      generateTrip().catch(console.error);
      return;
    }

    const vibeButton = event.target.closest("[data-vibe]");
    if (!vibeButton) return;
    const card = event.target.closest("[data-traveler]");
    const traveler = travelers[Number(card.dataset.traveler)];
    const vibe = vibeButton.dataset.vibe;
    if (traveler.vibes.includes(vibe)) {
      traveler.vibes = traveler.vibes.filter((item) => item !== vibe);
    } else {
      traveler.vibes = [...traveler.vibes, vibe];
    }
    renderTravelers();
  });

  travelerList.addEventListener("input", (event) => {
    console.log("travelerList input fired", event.target.className);

    // 原有的 must-visit 文字更新逻辑
    const input = event.target.closest("[data-must-visit]");
    if (input) {
      const card = event.target.closest("[data-traveler]");
      travelers[Number(card.dataset.traveler)]
        .mustVisits[Number(input.dataset.mustVisit)] = input.value;
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
}

function t(key) {
  return i18n[state.language][key] ?? i18n.zh[key] ?? key;
}

function applyLanguage() {
  document.documentElement.lang = state.language === "zh" ? "zh-CN" : "en";
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  Object.entries(t("countryNames")).forEach(([value, label]) => {
    const option = countryInput.querySelector(`option[value="${value}"]`);
    if (option) option.textContent = label;
  });
  Object.entries(t("nationalityNames")).forEach(([value, label]) => {
    const option = nationalityInput.querySelector(`option[value="${value}"]`);
    if (option) option.textContent = label;
  });
  languageInput.value = state.language;
}

function renderCityOptions(selectedCity) {
  const cities = countryCities[countryInput.value] || countryCities.Japan;
  destinationInput.innerHTML = cities
    .map((city) => `<option value="${city}" ${city === selectedCity ? "selected" : ""}>${city}</option>`)
    .join("");
  if (!cities.includes(destinationInput.value)) destinationInput.value = cities[0];
}

function renderCityTags() {
  if (!cityTags) return;

  const countryOptions = countryCities[countryInput.value] || countryCities.Japan;
  state.cities = state.cities.filter((city) => countryOptions.includes(city));
  if (!state.cities.length) state.cities = [countryOptions[0] || "Tokyo"];
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
    const available = countryOptions.filter((city) => !state.cities.includes(city));
    cityAddSelect.innerHTML = available
      .map((city) => `<option value="${city}">${city}</option>`)
      .join("");
  }

  renderAccommodationOptions();
}

function inferCountryForCity(city) {
  return Object.entries(countryCities).find(([, cities]) => cities.includes(city))?.[0] || "Japan";
}

function vibeLabel(id) {
  return t("vibeNames")[id] || id;
}

function renderAccommodationOptions(savedAreas = []) {
  const days = Number(daysInput.value || 1);
  hotelAreaList.innerHTML = Array.from({ length: days }, (_, index) => {
    const saved = savedAreas[index];
    let savedCity = saved?.city || state.cities[0] || "Tokyo";
    if (!state.cities.includes(savedCity)) savedCity = state.cities[0] || "Tokyo";
    const savedAreaId = saved?.areaId || saved?.id || (typeof saved === "string" ? saved : "");
    const cityOptions = state.cities
      .map((city) => `
        <option value="${city}" ${city === savedCity ? "selected" : ""}>
          ${city}
        </option>
      `)
      .join("");
    const areas = getAreasForCity(savedCity);
    const areaOptions = areas
      .map(([id, label]) => `
        <option value="${id}" ${id === savedAreaId ? "selected" : ""}>
          ${label}
        </option>
      `)
      .join("");
    return `
      <div class="hotel-day-row" data-day-index="${index}">
        <span class="hotel-day-label"
              style="color:${["#6c5ce7", "#00cec9", "#fd79a8", "#f0a04b", "#a29bfe"][index % 5]}">
          Day ${index + 1}
        </span>
        <select class="hotel-city-select" data-hotel-day="${index}" data-type="city">
          ${cityOptions}
        </select>
        <select class="hotel-area-select" data-hotel-day="${index}" data-type="area">
          ${areaOptions}
        </select>
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
        const areaSelect = hotelAreaList.querySelector(`.hotel-area-select[data-hotel-day="${dayIndex}"]`);
        if (areaSelect) {
          const areas = getAreasForCity(newCity);
          areaSelect.innerHTML = areas
            .map(([id, label]) => `<option value="${id}">${label}</option>`)
            .join("");
        }
        generateTrip().catch(console.error);
      });
    });
}

function resetMustVisitsForDestination() {
  const defaults = defaultMustVisits[destinationInput.value] || defaultMustVisits.Tokyo;
  if (!defaults) return;
  travelers.forEach((traveler, index) => {
    traveler.mustVisits = [...defaults[index]];
  });
}

function renderTravelers() {
  travelerList.innerHTML = travelers
    .map((traveler, travelerIndex) => {
      return `
        <article class="traveler-card traveler-editor" data-traveler="${travelerIndex}">
          <div class="avatar" style="--avatar-color: ${traveler.color}">${traveler.name[0]}</div>
          <div>
            <div class="traveler-topline">
              <strong>${traveler.name}</strong>
              <span>${traveler.role} · ${traveler.budget}</span>
            </div>
            <div class="mini-vibe-grid">
              ${vibeOptions.map(([id, label]) => `
                <button class="mini-vibe ${traveler.vibes.includes(id) ? "is-selected" : ""}" type="button" data-vibe="${id}">
                  ${vibeLabel(id)}
                </button>
              `).join("")}
            </div>
            <div class="must-visit-grid">
              ${traveler.mustVisits.map((place, placeIndex) => `
                <label>
                  ${state.language === "zh" ? "必去" : "Must visit"} ${placeIndex + 1}
                  <div class="nomination-wrap"
                       data-traveler-idx="${travelerIndex}"
                       data-place-idx="${placeIndex}">
                    <input
                      class="nomination-input"
                      data-must-visit="${placeIndex}"
                      value="${place}"
                      placeholder="Search a place..."
                      autocomplete="off" />
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

async function generateTrip() {
  const destination = state.cities[0] || destinationInput.value;
  if (destinationInput) destinationInput.value = destination;
  const country = countryInput.value;
  const plan = getActivePlan();
  const budgetMax = Number(budgetMaxInput.value || 0);
  const budgetMin = Number(budgetMinInput.value || Math.round(budgetMax * 0.72));
  const days = Number(daysInput.value || 5);
  const hotelStars = Number(hotelStarsInput.value || 3);
  syncHotelAreaCount(days);
  const hotelAreas = getHotelAreas(plan, days);
  const discoveryMode = discoveryModeInput.value === "on";
  const transportMode = transportModeInput.value;
  const groupVibes = [...new Set(travelers.flatMap((traveler) => traveler.vibes))];

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
  cityCentersCache = {};
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
      try {
        const res = await fetch(
          `/api/geocode?address=${encodeURIComponent(hotel.label + " " + hotel.city)}`
        );
        const data = await res.json();
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
          return places.map((place) => ({ ...place, city }));
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
    ? { ...plan, places: [...normalizedStaticPlaces, ...apiSystemPlaces] }
    : { ...plan, places: normalizedStaticPlaces };

  const geocodedPlaces = await geocodePlaces(
    enrichedPlan.places,
    cityCenter
  );

  const nominationCityMap = {};
  await Promise.all(
    travelers.flatMap((traveler) => traveler.mustVisits.filter(Boolean))
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
              if (addr.includes((city || "").toLowerCase())) {
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

  const roadmap = generateRoadmap({
    plan: prePlan,
    travelers,
    groupVibes,
    budgetMin,
    budgetMax,
    days,
    hotelAreas: geocodedHotels,
    discoveryMode,
    transportMode,
    hotelStars,
    nominationCityMap
  });

  state.latestTrip = { destination, country, cities: state.cities, plan: prePlan, hotelAreas: geocodedHotels, budgetMin, budgetMax, days, discoveryMode, transportMode, hotelStars, groupVibes, cityCenter, ...roadmap };
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
  renderTrip();
}

function getActivePlan() {
  return destinationPlans[destinationInput.value] || createGenericPlan(destinationInput.value, countryInput.value);
}

function createGenericPlan(city, country) {
  const base = country === "France" ? destinationPlans.Paris : destinationPlans.Tokyo;
  const label = `${city}, ${country}`;
  return {
    ...base,
    label,
    center: `${city} center - Old town - Local district`,
    visaDays: base.visaDays,
    areas: [
      ["center", `${city} Center`, 50, 50],
      ["station", `${city} Station Area`, 42, 58],
      ["old-town", `${city} Old Town`, 58, 38],
      ["waterfront", `${city} Waterfront`, 65, 62]
    ],
    places: base.places.map((place, index) => [
      `${city} ${place[0]}`,
      place[1],
      clamp(place[2] + ((index % 3) - 1) * 6, 18, 82),
      clamp(place[3] + ((index % 2) ? 7 : -5), 18, 82),
      place[4],
      place[5],
      place[6],
      place[7],
      place[8],
      place[9],
      city
    ])
  };
}

function syncHotelAreaCount(days) {
  const current = Array.from({ length: Number(days || 1) }, (_, index) => {
    const city = hotelAreaList.querySelector(`.hotel-city-select[data-hotel-day="${index}"]`)?.value;
    const areaId = hotelAreaList.querySelector(`.hotel-area-select[data-hotel-day="${index}"]`)?.value;
    return city || areaId ? { city, areaId } : null;
  }).filter(Boolean);
  if (current.length !== days) renderAccommodationOptions(current);
}

function getHotelAreas(plan, days) {
  void plan;
  const citySelects = [...hotelAreaList.querySelectorAll(".hotel-city-select")];
  const areaSelects = [...hotelAreaList.querySelectorAll(".hotel-area-select")];
  return Array.from({ length: days }, (_, index) => {
    const city = citySelects[index]?.value || state.cities[0] || "Tokyo";
    const areaId = areaSelects[index]?.value || "";
    const areas = getAreasForCity(city);
    const area = areas.find((item) => item[0] === areaId) || areas[0];
    return { id: area[0], label: area[1], x: area[2], y: area[3], city };
  });
}

async function geocodePlaces(places, cityCenter) {
  void cityCenter;
  return Promise.all(places.map(async (place) => {
    if (place.lat && place.lng) return assignCityToPlace(place);
    try {
      const res = await fetch(
        `/api/geocode?address=${encodeURIComponent(place.searchQuery || (place.name + " " + countryInput.value))}`
      );
      const data = await res.json();
      if (data.lat) {
        return assignCityToPlace({ ...place, lat: data.lat, lng: data.lng, formattedAddress: data.formattedAddress || place.formattedAddress || "" });
      }
    } catch {}
    return place;
  }));
}

async function assignCityToPlace(place) {
  if (!place.lat || !place.lng) return place;

  const cities = state.cities || ["Tokyo"];
  if (cities.length === 1) {
    return { ...place, city: cities[0] };
  }

  if (place.formattedAddress) {
    const addr = (place.formattedAddress || "").toLowerCase();
    for (const city of cities) {
      if (addr.includes((city || "").toLowerCase())) {
        console.log("assignCity by address:", place.name, "→", city);
        return { ...place, city };
      }
    }
  }

  try {
    const res = await fetch(
      `/api/geocode?address=${encodeURIComponent(place.name + " " + countryInput.value)}`
    );
    const data = await res.json();
    if (data.formattedAddress) {
      const addr = (data.formattedAddress || "").toLowerCase();
      for (const city of cities) {
        if (addr.includes((city || "").toLowerCase())) {
          console.log("assignCity by geocode:", place.name, "→", city, "address:", data.formattedAddress);
          return {
            ...place,
            city,
            lat: data.lat || place.lat,
            lng: data.lng || place.lng,
            formattedAddress: data.formattedAddress
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
  return { ...place, city: nearestCity };
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

      if (photoName) {
        return {
          ...place,
          image: `/api/photo?name=${encodeURIComponent(photoName)}`
        };
      }
    } catch {}
    return place;
  }));
}

function generateRoadmap({ plan, travelers, groupVibes, budgetMin, budgetMax, days, hotelAreas, discoveryMode, transportMode, hotelStars, nominationCityMap = {} }) {
  const travelerCount = Number(travelerCountInput?.value || 4);
  const roomsNeeded = Math.ceil(travelerCount / 2);
  const hotelCostPerNight = (hotelCostUSD[hotelStars] || hotelCostUSD[3]) * roomsNeeded;
  const hotelCostPerPersonPerNight = Math.round(hotelCostPerNight / travelerCount);
  const totalBudgetCap = budgetMax;
  const hotelTotalCost = hotelCostPerPersonPerNight * days;
  const activityBudgetCap = Math.max(0, totalBudgetCap - hotelTotalCost);
  const activityBudgetPerDay = Math.round(activityBudgetCap / Math.max(1, days));
  const activityBudgetTotal = activityBudgetCap;
  const BUDGET_FLEX = 1.15;
  const hardCap = activityBudgetCap * BUDGET_FLEX;
  const targetCount = Math.min(15, Math.max(days * 2, days * 3));
  const systemPlaces = plan.places.map((place, index) => normalizePlace(place, index, "system"));
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
  const candidates = poolWithCity.map((place) => scoreCandidate(place, travelers, groupVibes, activityBudgetPerDay, hotelAreas));
  const shortList = diversifyCandidates(candidates, targetCount, discoveryMode);
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
  const clusteredDays = rebalanceDayClusters(clusterDays(budgetResult.kept, hotelAreas, transportMode), days, reservePool, hotelAreas, transportMode);
  const itineraryDays = buildDayRoutes(clusteredDays, hotelAreas, transportMode);
  const orderedPlaces = itineraryDays.flatMap((day) => day.places);
  const legs = itineraryDays.flatMap((day) => day.legs);
  const routeCost = itineraryDays.reduce((sum, day) => sum + day.routeCost, 0);
  const hotelCost = hotelCostPerPersonPerNight * days;
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
      maxTravelMin: maxTravelByMode[transportMode],
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
    image: place[7],
    lat: place[8] || null,
    lng: place[9] || null,
    city: place[10] || place.city || "",
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
    .map((hotel) => ({ hotel, dist: distance(place, hotel) }))
    .sort((a, b) => a.dist - b.dist)[0]?.hotel;
  const routeDistance = referenceHotel ? distance(place, referenceHotel) : 0;
  const routeEfficiency = Math.max(0, 100 - routeDistance * 1.6);
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

function diversifyCandidates(candidates, count, discoveryMode) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score || a.cost - b.cost);
  const chosen = [];
  const vibeCountsByCity = new Map();
  const nominated = sorted.filter((candidate) => candidate.source === "nominated");
  const system = sorted.filter((candidate) => candidate.source !== "nominated");

  for (const candidate of [...nominated, ...system]) {
    const cityVibeKey = `${candidate.city || "unknown"}:${candidate.vibe}`;
    const currentCount = vibeCountsByCity.get(cityVibeKey) || 0;
    if (currentCount < maxPerVibe) {
      chosen.push(candidate);
      vibeCountsByCity.set(cityVibeKey, currentCount + 1);
    }
    if (chosen.length >= count) break;
  }

  return chosen;
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

function clusterDays(places, hotelAreas, transportMode = "TRANSIT") {
  void transportMode;
  console.log("clusterDays places with city:", places.map((place) => ({ name: place.name, city: place.city })));
  const k = hotelAreas.length;
  const clusters = Array.from({ length: k }, () => []);
  const dayIndicesByCity = new Map();
  const flightDayIndex = state.flightDepartureTime ? k - 1 : null;

  hotelAreas.forEach((hotel, index) => {
    if (index === flightDayIndex) return;
    const city = hotel.city || "unknown";
    if (!dayIndicesByCity.has(city)) dayIndicesByCity.set(city, []);
    dayIndicesByCity.get(city).push(index);
  });

  const placesByCity = new Map();
  places.forEach((place) => {
    const city = place.city && dayIndicesByCity.has(place.city)
      ? place.city
      : hotelAreas
        .map((hotel, index) => ({ index, city: hotel.city, dist: distance(place, hotel) }))
        .sort((a, b) => a.dist - b.dist)[0]?.city || "unknown";
    if (!placesByCity.has(city)) placesByCity.set(city, []);
    placesByCity.get(city).push(place);
  });

  placesByCity.forEach((cityPlaces, city) => {
    const dayIndices = dayIndicesByCity.get(city) || [];
    if (!dayIndices.length) return;

    const sortedPlaces = cityPlaces
      .slice()
      .sort((a, b) => b.score - a.score || distance(a, hotelAreas[dayIndices[0]]) - distance(b, hotelAreas[dayIndices[0]]));
    const nominatedPlaces = sortedPlaces.filter((place) => (place.nominations || []).length > 0);
    const remainingPlaces = sortedPlaces.filter((place) => !(place.nominations || []).length);

    nominatedPlaces.forEach((place, placeIndex) => {
      const dayIndex = dayIndices[placeIndex % dayIndices.length];
      clusters[dayIndex].push(place);
    });

    remainingPlaces.forEach((place) => {
      const dayIndex = dayIndices
        .map((index) => ({
          index,
          load: clusters[index].length,
          dist: distance(place, hotelAreas[index])
        }))
        .sort((a, b) => a.load - b.load || a.dist - b.dist)[0].index;
      clusters[dayIndex].push(place);
    });
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
    const dayCity = hotelAreas[index]?.city || "";
    const sameCityCandidates = unassigned
      .map((place, reserveIndex) => ({ place, reserveIndex }))
      .filter(({ place }) => {
        if (place.city && dayCity) return place.city === dayCity;
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

  const centroids = clusters.map((cluster, index) => {
    if (!cluster.length) return { x: hotelAreas[index].x, y: hotelAreas[index].y };
    const mean = {
      x: cluster.reduce((sum, place) => sum + place.x, 0) / cluster.length,
      y: cluster.reduce((sum, place) => sum + place.y, 0) / cluster.length
    };
    return {
      x: hotelAreas[index].x * 0.3 + mean.x * 0.7,
      y: hotelAreas[index].y * 0.3 + mean.y * 0.7
    };
  });

  return clusters.map((placesForDay, index) => ({ index, places: placesForDay, centroid: centroids[index], hotel: hotelAreas[index] }));
}

function rebalanceDayClusters(dayClusters, days, reservePool = [], hotelAreas = [], transportMode = "TRANSIT") {
  const totalPlaces = dayClusters.reduce((sum, day) => sum + day.places.length, 0);
  const targetPerDay = Math.ceil(totalPlaces / Math.max(1, days));
  const assignedIds = new Set(dayClusters.flatMap((day) => day.places.map((place) => place.id)));
  const flightDayIndex = state.flightDepartureTime ? dayClusters.length - 1 : null;
  let moved = true;

  while (moved && dayClusters.some((day) => day.places.length > targetPerDay + 1)) {
    moved = false;
    for (const day of dayClusters.filter((cluster) => cluster.index !== flightDayIndex && cluster.places.length > targetPerDay + 1)) {
      const underloaded = dayClusters.filter((cluster) => cluster.index !== flightDayIndex && cluster.places.length < targetPerDay);
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
              hotelAreas[Math.max(0, cluster.index - 1)] || hotelAreas[cluster.index] || cluster.hotel
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
        hotelAreas[Math.max(0, day.index - 1)] || hotelAreas[day.index] || day.hotel
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
    if (day.index === flightDayIndex) {
      day.places = [];
      continue;
    }
    const dayHotel = hotelAreas[day.index] || day.hotel;
    const startPoint = hotelAreas[Math.max(0, day.index - 1)] || dayHotel;
    while (day.places.length && !routeLegsWithinThreshold(day.places, startPoint, transportMode)) {
      const weakest = day.places
        .map((place, index) => ({ place, index }))
        .sort((a, b) => a.place.score - b.place.score)[0];
      if (!weakest) break;
      const [dropped] = day.places.splice(weakest.index, 1);
      assignedIds.delete(dropped.id);
      const substituteIndex = reservePool.findIndex((place) => !assignedIds.has(place.id) && dayAccepts(place, day.places, dayHotel, transportMode, startPoint));
      if (substituteIndex >= 0) {
        const substitute = { ...reservePool.splice(substituteIndex, 1)[0], isSubstitute: true };
        day.places.push(substitute);
        assignedIds.add(substitute.id);
      }
    }
  }

  return dayClusters;
}

function dayAccepts(place, places, dayHotel, transportMode = "TRANSIT", startPoint = dayHotel) {
  if (place.city && dayHotel?.city && place.city !== dayHotel.city) {
    return false;
  }
  return routeLegsWithinThreshold([...places, place], startPoint, transportMode);
}

function buildDayRoutes(dayClusters, hotelAreas, transportMode = "TRANSIT") {
  return dayClusters.map((cluster, index) => {
    const hotel = hotelAreas[index] || cluster.hotel || { x: 50, y: 50, label: "Hotel" };
    const startHotel = hotelAreas[Math.max(0, index - 1)] || hotel;
    const orderedPlaces = orderRoute(cluster.places, startHotel, transportMode);
    const places = index === dayClusters.length - 1
      ? trimLastDayForFlight(orderedPlaces, getLastDayCutoffMin(hotel, transportMode))
      : orderedPlaces;
    const legs = buildRouteLegs(places, transportMode, startHotel);
    const vibeCounts = countBy(places, (place) => place.vibe);
    const routeCost = legs.reduce((sum, leg) => sum + leg.cost, 0);
    return {
      day: index + 1,
      hotel,
      places,
      legs,
      routeCost,
      routeMinutes: legs.reduce((sum, leg) => sum + leg.minutes, 0),
      cost: places.reduce((sum, place) => sum + place.cost, 0) + 115 + routeCost,
      diversityWarning: Math.max(0, ...Object.values(vibeCounts)) > maxPerVibe
    };
  });
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

function orderRoute(places, accommodation = { x: 50, y: 50 }, transportMode = "TRANSIT") {
  if (places.length < 2) return places;
  const remaining = [...places];
  const startIndex = remaining
    .map((place, index) => ({ index, dist: distance(accommodation, place) }))
    .sort((a, b) => a.dist - b.dist)[0].index;
  const route = [remaining.splice(startIndex, 1)[0]];

  while (remaining.length) {
    const current = route[route.length - 1];
    const nextIndex = remaining
      .map((place, index) => ({
        index,
        utility: place.score - travelTimeBetween(current, place, transportMode) * 0.35 - place.cost * 0.1
      }))
      .sort((a, b) => b.utility - a.utility)[0].index;
    route.push(remaining.splice(nextIndex, 1)[0]);
  }

  return route;
}

function maxRouteLegMinutes(places, startPoint, transportMode = "TRANSIT") {
  if (!places.length) return 0;
  const orderedPlaces = orderRoute(places, startPoint, transportMode);
  const legs = buildRouteLegs(orderedPlaces, transportMode, startPoint);
  return Math.max(0, ...legs.map((leg) => leg.minutes));
}

function routeLegsWithinThreshold(places, startPoint, transportMode = "TRANSIT") {
  return maxRouteLegMinutes(places, startPoint, transportMode) <= maxTravelByMode[transportMode];
}

function buildRouteLegs(places, transportMode = "TRANSIT", startPoint = null) {
  return places.map((place, index) => {
    const previous = index === 0 ? startPoint : places[index - 1];
    if (!previous) return { mode: "集合", label: "起点集合", minutes: 0, cost: 0 };
    const dist = distance(previous, place);
    const mode = getLegMode(dist, transportMode);
    const minutes = Math.round(travelTimeBetween(previous, place, transportMode));
    const cost = mode === "步行" ? 0 : mode === "公交" ? 4 : mode === "驾车" ? 12 : 7;
    return { mode, label: `${mode} ${minutes} 分钟`, minutes, cost };
  });
}

function getLegMode(dist, transportMode = "TRANSIT") {
  if (transportMode === "DRIVING") return dist < 12 ? "步行" : "驾车";
  return dist < 15 ? "步行" : dist < 35 ? "公交" : "地铁";
}

function travelTimeBetween(a, b, transportMode = "TRANSIT") {
  const dist = distance(a, b);
  if (transportMode === "DRIVING") {
    return dist < 20 ? dist * 2 : dist * 1;
  }
  if (dist < 15) return dist * 3;
  if (dist < 35) return dist * 2;
  return dist * 1.2;
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

const placeAliases = {
  "金阁寺": "kinkakuji",
  "kinkaku-ji": "kinkakuji",
  "kinkakuji": "kinkakuji",
  "岚山竹林": "arashiyamabambooforest",
  "arashiyama bamboo forest": "arashiyamabambooforest",
  "arashiyamabambooforest": "arashiyamabambooforest",
  "伏见稻荷大社": "fushimiinaritaisha",
  "fushimi inari taisha": "fushimiinaritaisha",
  "fushimiinaritaisha": "fushimiinaritaisha",
  "锦市场": "nishikimarket",
  "nishiki market": "nishikimarket",
  "nishikimarket": "nishikimarket",
  "根津美术馆": "nezumuseum",
  "nezu museum": "nezumuseum",
  "nezumuseum": "nezumuseum",
  "筑地场外市场": "tsukijifishmarket",
  "tsukiji outer market": "tsukijifishmarket",
  "新宿黄金街": "shinjukukabukicho",
  "golden gai": "shinjukukabukicho",
  "teamlab planets": "teamlabplanets",
  "teamlab planets tokyo dmm": "teamlabplanets",
  "上野公园": "uenopark",
  "ueno park": "uenopark",
  "uenopark": "uenopark",
  "上野": "uenopark"
};

function normalizeForMatch(text) {
  const lowerWithSpaces = (text || "").toLowerCase();
  const lower = lowerWithSpaces
    .replace(/\s+/g, "")
    .replace(/[·•\-]/g, "");
  return placeAliases[lower] ||
         placeAliases[lowerWithSpaces] ||
         lower;
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

  const hotelSummary = summarizeHotelAreas(trip.hotelAreas);
  title.textContent = `${trip.plan.label} · ${trip.days} 天 · ${hotelSummary}`;
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
  const visaDays = trip.plan.visaDays[nationalityInput.value] ?? 0;
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
    ? `${travelerCount} travelers · ${roomsNeeded} room(s) · $${hotelCostPerRoomPerNight}/room/night · $${hotelCostPerPersonPerNight}/person/night · Activity budget $${activityBudgetPerDay}/day/person`
    : `${travelerCount} 人出行 · ${roomsNeeded} 间客房 · $${hotelCostPerRoomPerNight}/间/晚 · 每人分摊 $${hotelCostPerPersonPerNight}/晚 · 活动预算 $${activityBudgetPerDay}/天/人`;
}

function renderReservePool(trip) {
  if (!reservePoolList) return;

  if (reservePoolSection) reservePoolSection.style.display = "";

  const finalIds = new Set(trip.places.map((place) => place.id));
  const reserveCandidates = (trip.allCandidates || [])
    .filter((place) => !finalIds.has(place.id))
    .sort((a, b) => b.score - a.score);

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
      return `
        <div class="reserve-card"
             data-reserve-id="${place.id}"
             data-lat="${place.lat || ""}"
             data-lng="${place.lng || ""}">
          <div class="reserve-card-name">${place.name}</div>
          <div class="reserve-card-meta">
            <span class="reserve-card-vibe">${vibeLabel}</span>
            <span class="reserve-card-cost">$${place.cost}</span>
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
              <strong>${place.score}/100</strong>
            </div>
            <p>${place.description}</p>
            <div class="route-meta">
              <span class="route-chip">${transport} ${leg.label}</span>
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
            <span>${day.hotel.label} · ${day.places.length} ${state.language === "en" ? "stops" : "站"} · ${day.routeMinutes} min · $${day.cost}${day.diversityWarning ? (state.language === "en" ? " · ⚠ vibe concentration" : " · ⚠ 氛围集中") : ""}${day.places.some((place) => place.isSubstitute) ? " · substitute" : ""}</span>
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

function showDetail(index) {
  const trip = state.latestTrip;
  const place = trip.places[index];
  state.activeIndex = index;
  renderGoogleMap(trip);
  detailImage.src = place.image;
  detailImage.alt = place.name;
  const placeCity = place.city ||
    trip.destination ||
    trip.plan.label;
  const kickerLabel = state.language === "en"
    ? `${placeCity}, ${trip.country} · Route detail`
    : `${placeCity}，${t("countryNames")[trip.country] || trip.country} · 路径详情`;
  detailKicker.textContent = kickerLabel;
  detailTitle.textContent = place.name;
  const supporters = place.supporters.map((traveler) => traveler.name);
  const nominatedBy = place.nominations.map((item) => `${item.member} #${item.rank}`);
  const leg = trip.legs[index];
  detailBody.textContent = state.language === "en"
    ? `${place.description} Estimated cost is $${place.cost}; connection from previous stop is ${leg.label}. ${place.isSubstitute ? `This is a reserve-pool substitute that satisfies the ${trip.algorithm.maxTravelMin}-minute same-day travel constraint. ` : ""}${nominatedBy.length ? `Nominated by: ${nominatedBy.join(", ")}. ` : "System recommendation used for discovery and route diversity. "}${supporters.length ? `Vibe match: ${supporters.join(", ")}. ` : ""}Algorithm rationale: ${place.rationale}.`
    : `${place.description} 预计单点花费 $${place.cost}，从上一站衔接方式为 ${leg.label}。${place.isSubstitute ? `这是备用池替换点，用于满足当前交通方式下单日任意两点不超过 ${trip.algorithm.maxTravelMin} 分钟的移动约束。` : ""}${nominatedBy.length ? `成员提名：${nominatedBy.join("、")}。` : "系统推荐点，用于补足发现模式和路线多样性。"}${supporters.length ? `氛围匹配：${supporters.join("、")}。` : ""}算法理由：${place.rationale}。`;
  dialog.showModal();
}

function updateHash(trip) {
  const payload = {
    d: trip.destination,
    cities: state.cities,
    hotels: trip.hotelAreas.map((hotel) => ({ city: hotel.city, areaId: hotel.id })),
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
    if (payload.country && countryCities[payload.country]) countryInput.value = payload.country;
    else countryInput.value = inferCountryForCity(payload.d || destinationInput.value);
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
      : Array.from({ length: Number(payload.day || daysInput.value || 1) }, () => ({ city: state.cities[0], areaId: payload.a })).filter((item) => item.areaId);
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

destinationInput.addEventListener("change", () => {
  state.cities = [destinationInput.value];
  renderCityTags();
  renderAccommodationOptions();
  resetMustVisitsForDestination();
  renderTravelers();
  generateTrip();
});

countryInput.addEventListener("change", () => {
  state.cities = [
    countryCities[countryInput.value]?.[0] || "Tokyo"
  ];
  renderCityTags();
  resetMustVisitsForDestination();
  renderTravelers();
  generateTrip();
});

daysInput.addEventListener("change", () => {
  renderAccommodationOptions(Array.from({ length: Number(daysInput.value || 1) }, (_, index) => {
    const city = hotelAreaList.querySelector(`.hotel-city-select[data-hotel-day="${index}"]`)?.value;
    const areaId = hotelAreaList.querySelector(`.hotel-area-select[data-hotel-day="${index}"]`)?.value;
    return city || areaId ? { city, areaId } : null;
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
  renderCityTags();
  generateTrip().catch(console.error);
});

cityAddBtn?.addEventListener("click", () => {
  const city = cityAddSelect?.value;
  if (!city || state.cities.includes(city)) return;
  state.cities.push(city);
  renderCityTags();
  generateTrip().catch(console.error);
});

applyHotelAll.addEventListener("click", () => {
  const firstCity = hotelAreaList.querySelector(".hotel-city-select")?.value;
  const firstArea = hotelAreaList.querySelector(".hotel-area-select")?.value;
  if (!firstCity && !firstArea) return;
  hotelAreaList.querySelectorAll(".hotel-city-select").forEach((select) => {
    select.value = firstCity;
  });
  hotelAreaList.querySelectorAll(".hotel-area-select").forEach((select) => {
    select.innerHTML = getAreasForCity(firstCity)
      .map(([id, label]) => `<option value="${id}">${label}</option>`)
      .join("");
    select.value = firstArea;
  });
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
languageInput.addEventListener("change", () => {
  state.language = languageInput.value;
  applyLanguage();
  renderAccommodationOptions([...hotelAreaList.querySelectorAll("[data-hotel-day]")].map((select) => select.value));
  renderTravelers();
  generateTrip();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  generateTrip();
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

shareButton.addEventListener("click", async () => {
  const url = window.location.href;
  try {
    await navigator.clipboard.writeText(url);
    showToast("只读分享链接已复制");
  } catch {
    showToast(url);
  }
});

itineraryList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-index]");
  if (!card) return;
  showDetail(Number(card.dataset.index));
});

document.addEventListener("click", (event) => {
  const card = event.target.closest(".reserve-card");
  if (!card) return;

  const lat = parseFloat(card.dataset.lat);
  const lng = parseFloat(card.dataset.lng);
  const id = card.dataset.reserveId;

  document.querySelectorAll(".reserve-card")
    .forEach((item) => item.classList.remove("active"));
  card.classList.add("active");

  if (!googleMap || !window.google || Number.isNaN(lat) || Number.isNaN(lng)) return;

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

  if (window._reserveInfoWindow) {
    window._reserveInfoWindow.close();
  }
  const trip = state.latestTrip;
  const place = (trip?.allCandidates || [])
    .find((candidate) => candidate.id === id);

  window._reserveInfoWindow = new google.maps.InfoWindow({
    content: `
      <div style="max-width:200px;font-family:sans-serif">
        <strong style="font-size:13px">
          ${place?.name || ""}
        </strong>
        <p style="font-size:12px;color:#666;margin:4px 0">
          ${place?.description || place?.formattedAddress || ""}
        </p>
        <p style="font-size:12px;margin:4px 0">
          Score: ${place?.score}/100 · $${place?.cost}
        </p>
      </div>
    `
  });
  window._reserveInfoWindow.open(googleMap, window._reservePreviewMarker);
});

closeDialog.addEventListener("click", () => dialog.close());

console.log("app.js loaded");
console.log("travelerList at load time:", document.querySelector("#traveler-list"));

init();
