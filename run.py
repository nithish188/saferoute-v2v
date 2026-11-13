"""
Launcher for Smart V2V Collision System
Department of Computer Science and Engineering, Jai Shriram Engineering College
"""

import sys
import webbrowser
import threading
import time
import socket
import uvicorn

def find_available_port(start_port=8080, max_tries=10):
    for p in range(start_port, start_port + max_tries):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.bind(('127.0.0.1', p))
            s.close()
            return p
        except OSError:
            continue
    return start_port

def open_browser(url):
    time.sleep(1.2)
    print(f"\n[+] Opening Smart V2V Collision System in browser: {url}")
    webbrowser.open(url)

if __name__ == "__main__":
    port = find_available_port(8080)
    url = f"http://localhost:{port}"

    print("=" * 70)
    print(" Smart V2V Collision System")
    print(" Smartphone-Based Predictive Collision Warning with Emergency Vehicle Clearance & Women Safety")
    print(" Jai Shriram Engineering College, Tiruppur, Tamilnadu, India")
    print("=" * 70)
    print(f"[*] Starting server on {url}")
    print("[*] Google Maps interface ready at /")
    print("[*] WebSocket stream at /ws/stream")
    print("[*] Analytical Scenario runner ready (Table III: S1-S5)")
    print("=" * 70)

    # Launch browser in separate thread
    threading.Thread(target=open_browser, args=(url,), daemon=True).start()

    # Start FastAPI server
    uvicorn.run("backend.app:app", host="0.0.0.0", port=port, reload=False, log_level="info")

