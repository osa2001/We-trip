import { NextRequest, NextResponse } from "next/server";

type PlaceResult = {
  rating?: number;
  userRatingCount?: number;
};

type PlacesResponse = {
  places?: PlaceResult[];
  [key: string]: unknown;
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("query");
  const lat = searchParams.get("lat");
  const lng = searchParams.get("lng");
  const type = searchParams.get("type") || "nomination";

  const apiKey = process.env.GOOGLE_PLACES_SERVER_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "API key not configured" }, { status: 500 });
  }

  try {
    if (type === "nomination") {
      const url = "https://places.googleapis.com/v1/places:searchText";
      const body = {
        textQuery: query,
        locationBias: lat && lng ? {
          circle: {
            center: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
            radius: 20000
          }
        } : undefined,
        maxResultCount: 5,
        languageCode: "en"
      };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.priceLevel,places.rating,places.userRatingCount,places.photos,places.editorialSummary"
        },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      return NextResponse.json(data);

    } else if (type === "recommendations") {
      const includedTypes = searchParams.get("includedTypes") || "tourist_attraction";
      const url = "https://places.googleapis.com/v1/places:searchNearby";
      const body = {
        locationRestriction: {
          circle: {
            center: { latitude: parseFloat(lat!), longitude: parseFloat(lng!) },
            radius: 10000
          }
        },
        includedTypes: includedTypes.split(","),
        maxResultCount: 20,
        rankPreference: "POPULARITY",
        languageCode: "en"
      };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.priceLevel,places.rating,places.userRatingCount,places.photos,places.editorialSummary"
        },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      return NextResponse.json(data);

    } else if (type === "details") {
      const placeId = searchParams.get("placeId");
      if (!placeId) {
        return NextResponse.json({ error: "Missing placeId" }, { status: 400 });
      }
      const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
      const res = await fetch(url, {
        headers: {
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "id,displayName,formattedAddress,location,types,priceLevel,rating,userRatingCount,photos,editorialSummary"
        }
      });
      const data = await res.json();
      return NextResponse.json(data);


    } else if (type === "restaurants") {
      const url = "https://places.googleapis.com/v1/places:searchNearby";
      const body = {
        locationRestriction: {
          circle: {
            center: { latitude: parseFloat(lat!), longitude: parseFloat(lng!) },
            radius: 3000
          }
        },
        includedTypes: [
          "restaurant", "bar", "cafe", "bakery",
          "chinese_restaurant", "japanese_restaurant", "korean_restaurant",
          "italian_restaurant", "mexican_restaurant", "american_restaurant",
          "seafood_restaurant", "ramen_restaurant", "sushi_restaurant",
          "pizza_restaurant", "steak_house", "vegetarian_restaurant",
          "vegan_restaurant", "dessert_shop", "ice_cream_shop", "food_court"
        ],
        maxResultCount: 20,
        rankPreference: "DISTANCE",
        languageCode: "en"
      };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.types,places.priceLevel,places.rating,places.userRatingCount,places.photos,places.primaryType,places.editorialSummary"
        },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      return NextResponse.json(data);

    } else if (type === "hotels") {
      const minRating = searchParams.get("minRating") || "3.5";
      const destination = searchParams.get("destination") || "";
      const url = "https://places.googleapis.com/v1/places:searchNearby";
      const body = {
        locationRestriction: {
          circle: {
            center: { latitude: parseFloat(lat!), longitude: parseFloat(lng!) },
            radius: 2000
          }
        },
        includedTypes: ["hotel", "lodging"],
        maxResultCount: 5,
        rankPreference: "POPULARITY",
        languageCode: "en"
      };
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.priceLevel,places.rating,places.userRatingCount"
        },
        body: JSON.stringify(body)
      });
      const data = await res.json() as PlacesResponse;
      if (data.places) {
        const highTraffic = [
          "Tokyo", "Paris", "London", "Rome", "Barcelona",
          "New York City", "Los Angeles", "Amsterdam"
        ];
        const mediumTraffic = [
          "Berlin", "Madrid", "Florence", "Milan",
          "San Francisco", "Chicago", "Vienna"
        ];
        const minCount = highTraffic.includes(destination) ? 200
          : mediumTraffic.includes(destination) ? 100 : 50;

        data.places = data.places.filter(
          (place) => (place.rating ?? 0) >= parseFloat(minRating)
            && (place.userRatingCount || 0) >= minCount
        );
      }
      return NextResponse.json(data);
    }

    return NextResponse.json({ error: "Invalid type" }, { status: 400 });

  } catch {
    return NextResponse.json({ error: "Places API error" }, { status: 500 });
  }
}
