import urllib.request
import json
import time

start_lat, start_lon = 11.0168, 76.9558  # e.g. Coimbatore
end_lat, end_lon = 11.1042, 77.3458      # Tiruppur Old Bus Stand

coords = f"{start_lon},{start_lat};{end_lon},{end_lat}"
urls = [
    f"https://router.project-osrm.org/route/v1/driving/{coords}?overview=full&geometries=geojson&steps=true",
    f"https://routing.openstreetmap.de/routed-car/route/v1/driving/{coords}?overview=full&geometries=geojson&steps=true"
]

for url in urls:
    host = url.split('/')[2]
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (SmartV2V/1.0)"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            dur = time.time() - t0
            code = data.get("code")
            dist = data["routes"][0]["distance"] if data.get("routes") else 0
            n_pts = len(data["routes"][0]["geometry"]["coordinates"]) if data.get("routes") else 0
            print(f"{host}: code={code}, dist={dist}m, pts={n_pts}, time={dur:.2f}s")
    except Exception as e:
        dur = time.time() - t0
        print(f"{host}: FAILED in {dur:.2f}s: {e}")

