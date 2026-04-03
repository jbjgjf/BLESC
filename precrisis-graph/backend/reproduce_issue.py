import httpx
import json

def reproduce():
    url = "http://localhost:8001/api/entries"
    params = {
        "user_id": "test_user",
        "text": "Today I felt a bit anxious because of the meeting, but I managed to finish my work. I slept well last night."
    }
    try:
        response = httpx.post(url, params=params, timeout=30.0)
        print(f"Status Code: {response.status_code}")
        try:
            print(f"Response: {json.dumps(response.json(), indent=2)}")
        except:
            print(f"Raw Response: {response.text}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    reproduce()
