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
    const { origins, destinations, travelMode = "DRIVE" } = body;
    const googleTravelMode = travelMode === "DRIVING" ? "DRIVE" : travelMode;

    if (!origins?.length || !destinations?.length) {
      return NextResponse.json({ error: "Missing origins or destinations" }, { status: 400 });
    }

    if (googleTravelMode === "TRANSIT") {
      const params = new URLSearchParams({
        origin: `${origins[0].lat},${origins[0].lng}`,
        destination: `${destinations[0].lat},${destinations[0].lng}`,
        mode: "transit",
        departure_time: "now",
        key: apiKey
      });
      const url = `https://maps.googleapis.com/maps/api/directions/json?${params}`;
      const res = await fetch(url);
      const data = await res.json();
      const leg = data.routes?.[0]?.legs?.[0];
      return NextResponse.json(leg ? [{
        duration: `${leg.duration?.value || 0}s`,
        distanceMeters: leg.distance?.value || 0
      }] : []);
    }

    const url = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
    const payload = {
      origins: origins.map((origin) => ({
        waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } }
      })),
      destinations: destinations.map((destination) => ({
        waypoint: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } }
      })),
      travelMode: googleTravelMode,
      routingPreference: googleTravelMode === "DRIVE" ? "TRAFFIC_AWARE" : undefined,
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
