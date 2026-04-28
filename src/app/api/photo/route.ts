import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const photoName = searchParams.get("name");

  if (!photoName) {
    return NextResponse.json(
      { error: "Missing photo name" },
      { status: 400 }
    );
  }

  const apiKey = process.env.GOOGLE_PLACES_SERVER_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "API key not configured" },
      { status: 500 }
    );
  }

  const photoUrl =
    `https://places.googleapis.com/v1/${photoName}/media` +
    `?maxHeightPx=800&maxWidthPx=1200&key=${apiKey}`;

  return NextResponse.redirect(photoUrl);
}
