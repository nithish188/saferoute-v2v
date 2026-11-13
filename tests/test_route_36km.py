import urllib.request
import json

coords = '77.05,11.00;77.3458,11.1042'
url = f'https://router.project-osrm.org/route/v1/driving/{coords}?overview=full&geometries=geojson&steps=true'
req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
with urllib.request.urlopen(req, timeout=10) as r:
    data = json.loads(r.read().decode())
    route = data['routes'][0]
    dist = route['distance'] / 1000
    dur = route['duration'] / 60
    n_pts = len(route['geometry']['coordinates'])
    print(f"Distance: {dist:.1f} km, Duration: {dur:.0f} min, Points: {n_pts}")
    for s in route['legs'][0]['steps'][:5]:
        print("  -", s.get('name') or '(unnamed)', s.get('maneuver', {}).get('type'), f"{s.get('distance')}m")

