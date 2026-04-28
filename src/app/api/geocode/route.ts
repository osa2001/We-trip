import { NextRequest, NextResponse } from "next/server";

type GeocodeResult = {
  formatted_address: string;
  geometry: {
    location: {
      lat: number;
      lng: number;
    };
  };
};

type GeocodeResponse = {
  results?: GeocodeResult[];
};

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");

  const apiKey = process.env.GOOGLE_PLACES_SERVER_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "API key not configured" }, { status: 500 });
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address!)}&key=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json() as GeocodeResponse;

    if (data.results?.[0]) {
      const loc = data.results[0].geometry.location;
      return NextResponse.json({
        lat: loc.lat,
        lng: loc.lng,
        formattedAddress: data.results[0].formatted_address
      });
    }

    return NextResponse.json({ error: "No results" }, { status: 404 });

  } catch {
    return NextResponse.json({ error: "Geocode error" }, { status: 500 });
  }
}
