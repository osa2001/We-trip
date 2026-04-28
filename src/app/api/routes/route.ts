import { NextRequest, NextResponse } from "next/server";

type LatLng = {
  lat: number;
  lng: number;
};

type RouteMatrixRequestBody = {
  origins: LatLng[];
  destinations: LatLng[];
  travelMode?: string;
};

export async function POST(request: NextRequest) {
  const apiKey = process.env.GOOGLE_ROUTES_SERVER_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "API key not configured" }, { status: 500 });
  }

  try {
    const body = await request.json() as RouteMatrixRequestBody;
    const { origins, destinations, travelMode } = body;

    const url = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
    const payload = {
      origins: origins.map((origin) => ({
        waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } }
      })),
      destinations: destinations.map((destination) => ({
        waypoint: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } }
      })),
      travelMode: "DRIVE",
      routingPreference: travelMode === "DRIVING" ? "TRAFFIC_AWARE" : undefined,
      languageCode: "en"
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "*"
      },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    return NextResponse.json(data);

  } catch {
    return NextResponse.json({ error: "Routes API error" }, { status: 500 });
  }
}
