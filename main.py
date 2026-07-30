from fastapi import FastAPI, Body, HTTPException, Header
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
import requests
from datetime import datetime, timezone
from typing import Optional
import os
import re
import json
import time
from dotenv import load_dotenv
from google import genai
try:
    from zoneinfo import ZoneInfo
except ImportError:
    from backports.zoneinfo import ZoneInfo

load_dotenv()

app = FastAPI()
app.mount("/static", StaticFiles(directory="static"), name="static")
app.mount("/assets/penguin", StaticFiles(directory="penguin/source"), name="penguin")
app.mount("/assets/igloo", StaticFiles(directory="igloo"), name="igloo")
app.mount("/assets/snow_mountain", StaticFiles(directory="snow_mountain"), name="snow_mountain")

ACCESS_TOKEN = os.environ.get("CANVAS_ACCESS_TOKEN", "")
BASE_URL = os.environ.get("CANVAS_BASE_URL", "https://instructure.charlotte.edu/api/v1")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
CRON_SECRET = os.environ.get("CRON_SECRET", "").strip()
NTFY_SERVER = os.environ.get("NTFY_SERVER", "https://ntfy.sh").strip().rstrip("/")
AI_CACHE_TTL_SEC = 15 * 60
_ai_response_cache = {}
LOCAL_TZ = ZoneInfo("America/New_York")
HEADERS = {"Authorization": f"Bearer {ACCESS_TOKEN}", "Accept": "application/json"}

# --- USER SETTINGS ---
SETTINGS_FILE = "settings.json"
DEFAULT_STUDY_PROMPT = "You are an expert academic tutor. Analyze these upcoming assignments and their descriptions written by the professor. Provide a study plan for each. Keep it punchy and actionable."
DEFAULT_SETTINGS = {
    "display_name": "Quis",
    "theme": "light",
    "study_prompt": DEFAULT_STUDY_PROMPT,
    "ntfy_topic": "",
    "ntfy_enabled": False,
    "notify_remind_hours": 24,
    "notify_last_sent_at": "",
}

def _ai_cache_get(key):
    entry = _ai_response_cache.get(key)
    if not entry:
        return None
    if time.time() - entry["ts"] > AI_CACHE_TTL_SEC:
        del _ai_response_cache[key]
        return None
    return entry["payload"]

def _ai_cache_set(key, payload):
    _ai_response_cache[key] = {"ts": time.time(), "payload": payload}

def notify_check_interval_hours(remind_hours):
    try:
        hours = max(1, min(int(remind_hours), 168))
    except (TypeError, ValueError):
        hours = 24
    return max(1, min(24, hours // 4))

def require_cron_secret(
    authorization: Optional[str] = Header(None),
    x_cron_secret: Optional[str] = Header(None),
):
    if not CRON_SECRET:
        raise HTTPException(status_code=503, detail="CRON_SECRET is not configured on the server.")
    token = None
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:].strip()
    elif x_cron_secret:
        token = x_cron_secret.strip()
    if not token or token != CRON_SECRET:
        raise HTTPException(status_code=401, detail="Invalid cron secret.")

def persist_notify_last_sent(iso_timestamp):
    if not os.path.exists(SETTINGS_FILE):
        return
    try:
        with open(SETTINGS_FILE, "r") as f:
            raw = json.load(f)
        raw["notify_last_sent_at"] = iso_timestamp
        with open(SETTINGS_FILE, "w") as f:
            json.dump(raw, f, indent=2)
    except Exception as e:
        print(f"Could not persist notify_last_sent_at: {e}")

def should_send_scheduled_reminder(settings):
    if not settings.get("ntfy_enabled"):
        return False, "notifications disabled"
    if not normalize_ntfy_topic(settings.get("ntfy_topic", "")):
        return False, "ntfy topic not configured"

    remind_hours = settings.get("notify_remind_hours", 24)
    interval_hours = notify_check_interval_hours(remind_hours)
    last = (settings.get("notify_last_sent_at") or "").strip()
    if not last:
        return True, f"first scheduled check (every {interval_hours}h for {remind_hours}h window)"

    try:
        last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
        if last_dt.tzinfo is None:
            last_dt = last_dt.replace(tzinfo=LOCAL_TZ)
        last_dt = last_dt.astimezone(LOCAL_TZ)
    except ValueError:
        return True, "invalid last-sent timestamp; sending"

    hours_since = (datetime.now(LOCAL_TZ) - last_dt).total_seconds() / 3600
    if hours_since >= interval_hours:
        return True, f"{hours_since:.1f}h since last send (interval {interval_hours}h)"
    return False, f"skipped: {hours_since:.1f}h since last send (interval {interval_hours}h)"

def load_settings():
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r") as f:
                saved = json.load(f)
                merged = {**DEFAULT_SETTINGS, **saved}
                if saved.get("sms_enabled") and not saved.get("ntfy_enabled"):
                    merged["ntfy_enabled"] = saved["sms_enabled"]
                if saved.get("sms_remind_hours") and "notify_remind_hours" not in saved:
                    merged["notify_remind_hours"] = saved["sms_remind_hours"]
                return merged
        except Exception:
            pass
    return dict(DEFAULT_SETTINGS)

def save_settings(updates):
    current = load_settings()
    current.update({k: v for k, v in updates.items() if k in DEFAULT_SETTINGS})
    with open(SETTINGS_FILE, "w") as f:
        json.dump(current, f, indent=2)
    return current

# --- NTFY PUSH NOTIFICATIONS ---
def normalize_ntfy_topic(topic):
    cleaned = (topic or "").strip()
    if not cleaned or not re.fullmatch(r"[A-Za-z0-9_-]{3,64}", cleaned):
        return None
    return cleaned

def send_ntfy(topic, message, title="Guino"):
    normalized = normalize_ntfy_topic(topic)
    if not normalized:
        raise ValueError("Add a valid ntfy topic in Settings (letters, numbers, _ and - only).")

    headers = {"Title": title[:250]}
    response = requests.post(
        f"{NTFY_SERVER}/{normalized}",
        data=message.encode("utf-8"),
        headers=headers,
        timeout=10,
    )
    if response.status_code >= 400:
        raise ValueError(f"ntfy returned {response.status_code}. Check your topic and try again.")
    return {"topic": normalized, "status": response.status_code}

def build_reminder_message(assignments, display_name):
    name = display_name or "there"
    lines = [f"Assignment check-in for {name}:"]
    for assignment in assignments[:5]:
        lines.append(f"- {assignment['urgency']} {assignment['title']} ({assignment['course']}) due {assignment['due_str']}")
    if len(assignments) > 5:
        lines.append(f"...and {len(assignments) - 5} more on your dashboard.")
    return "\n".join(lines)

def get_assignments_for_reminder(remind_hours):
    courses = get_active_courses()
    assignments = get_all_upcoming_assignments(courses)
    return [a for a in assignments if 0 <= a["hours_left"] <= remind_hours]

# --- CANVAS LOGIC ---
def format_local_time(utc_string):
    if not utc_string: return "No Due Date", None
    utc_dt = datetime.strptime(utc_string, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    local_dt = utc_dt.astimezone(LOCAL_TZ)
    return local_dt.strftime("%a, %b %d at %I:%M %p"), local_dt

def calculate_urgency(due_dt):
    if not due_dt: return "⚪ UNDATED", 9999
    now = datetime.now(LOCAL_TZ)
    delta_hours = (due_dt - now).total_seconds() / 3600
    if delta_hours < 0: return "⚫ OVERDUE", delta_hours
    elif delta_hours <= 24: return "🔴 URGENT", delta_hours
    elif delta_hours <= 72: return "🟡 SOON", delta_hours
    else: return "🟢 LATER", delta_hours

def clean_course_name(name):
    # E.g., "202660-Summer 2026-ITCS-3190-081-Intro Cloud Comp Data Analysis" -> "ITCS 3190: Intro Cloud Comp Data Analysis"
    parts = name.split("-")
    if len(parts) >= 6:
        return f"{parts[2]} {parts[3]}: {parts[5]}"
    return name.split(" - ")[0]

def get_active_courses():
    url = f"{BASE_URL}/courses?enrollment_state=active&per_page=50"
    response = requests.get(url, headers=HEADERS)
    if response.status_code != 200: return []
    courses = []
    for c in response.json():
        if "id" in c and "name" in c and not c.get("access_restricted_by_date"):
            courses.append({"id": c["id"], "name": clean_course_name(c["name"])})
    return courses

def get_all_upcoming_assignments(courses):
    all_assignments = []
    for course in courses:
        url = f"{BASE_URL}/courses/{course['id']}/assignments"
        response = requests.get(url, headers=HEADERS, params={"bucket": "upcoming", "order_by": "due_at", "include[]": "submission", "per_page": 30})
        if response.status_code == 200:
            for a in response.json():
                sub = a.get("submission", {})
                if sub.get("workflow_state") == "submitted" or sub.get("submitted_at") is not None:
                    continue
                due_str, dt_obj = format_local_time(a.get("due_at"))
                badge, hrs = calculate_urgency(dt_obj)
                
                # Extract and clean the professor's instructions from HTML
                raw_desc = a.get("description") or ""
                clean_desc = re.sub(r'<[^>]+>', ' ', raw_desc).strip()
                
                all_assignments.append({
                    "course": course["name"],
                    "title": a.get("name"),
                    "description": clean_desc[:800], # Keep it brief for the AI prompt limit
                    "due_str": due_str,
                    "urgency": badge,
                    "hours_left": round(hrs, 1),
                    "url": a.get("html_url"),
                    "due_dt": dt_obj.isoformat() if dt_obj else None
                })
    all_assignments.sort(key=lambda x: x["due_dt"] or "9999")
    return all_assignments

def get_course_grades(courses):
    # Create a dictionary to easily map course IDs to names
    course_map = {c["id"]: c["name"] for c in courses}
    grades = []
    
    # Super-fast optimization: Get ALL your enrollments in ONE network call 
    # instead of looping through each course individually!
    url = f"{BASE_URL}/users/self/enrollments"
    params = {"state[]": "active"}
    response = requests.get(url, headers=HEADERS, params=params)
    
    if response.status_code == 200:
        enrollments = response.json()
        for enrollment in enrollments:
            course_id = enrollment.get("course_id")
            
            # Check if this enrollment matches one of our active courses
            if course_id in course_map and "grades" in enrollment:
                grade_data = enrollment["grades"]
                
                # Canvas often returns `null` (None in Python) if nothing is graded yet
                def safe_grade(key):
                    val = grade_data.get(key)
                    return "N/A" if val is None else val
                    
                grades.append({
                    "course": course_map[course_id],
                    "current_score": safe_grade("current_score"),
                    "current_grade": safe_grade("current_grade"),
                    "final_score": safe_grade("final_score"),
                    "final_grade": safe_grade("final_grade")
                })
    return grades

# --- API ENDPOINTS ---

@app.get("/")
def serve_landing():
    with open("landing.html", "r") as f:
        return HTMLResponse(content=f.read())

@app.get("/dashboard")
def serve_dashboard():
    with open("dashboard.html", "r") as f:
        return HTMLResponse(content=f.read())

@app.get("/gpa")
def serve_gpa_ui():
    try:
        with open("gpa.html", "r") as f:
            return HTMLResponse(content=f.read())
    except FileNotFoundError:
        return HTMLResponse(content="<h1>Error: gpa.html not found.</h1>", status_code=404)

@app.get("/study")
def serve_study_ui():
    try:
        with open("study.html", "r") as f:
            return HTMLResponse(content=f.read())
    except FileNotFoundError:
        return HTMLResponse(content="<h1>Error: study.html not found.</h1>", status_code=404)

@app.get("/settings")
def serve_settings_ui():
    try:
        with open("settings.html", "r") as f:
            return HTMLResponse(content=f.read())
    except FileNotFoundError:
        return HTMLResponse(content="<h1>Error: settings.html not found.</h1>", status_code=404)

@app.get("/privacy")
def serve_privacy():
    with open("privacy.html", "r") as f:
        return HTMLResponse(content=f.read())

@app.get("/terms")
def serve_terms():
    with open("terms.html", "r") as f:
        return HTMLResponse(content=f.read())

@app.get("/api/settings")
def get_settings():
    return {"status": "success", "settings": load_settings()}

@app.post("/api/settings")
def update_settings(payload: dict = Body(...)):
    updated = save_settings(payload)
    return {"status": "success", "settings": updated}

@app.get("/api/notify/status")
def notify_status():
    settings = load_settings()
    topic = normalize_ntfy_topic(settings.get("ntfy_topic", ""))
    return {
        "status": "success",
        "ntfy_server": NTFY_SERVER,
        "topic_configured": bool(topic),
        "notify_enabled": bool(settings.get("ntfy_enabled")),
        "ntfy_topic": topic or "",
        "notify_remind_hours": settings.get("notify_remind_hours", 24),
        "notify_check_interval_hours": notify_check_interval_hours(settings.get("notify_remind_hours", 24)),
    }

@app.post("/api/notify/test")
def send_test_notification():
    settings = load_settings()
    topic = settings.get("ntfy_topic", "")
    if not topic:
        raise HTTPException(status_code=400, detail="Add your ntfy topic in Settings first.")

    display_name = settings.get("display_name", "Quis")
    body = f"Hey {display_name}! Guino notifications are working. You'll get assignment reminders here when things are due soon."

    try:
        result = send_ntfy(topic, body, title="Guino test")
        return {"status": "success", "message": "Test notification sent.", "details": result}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"ntfy Error: {e}")
        raise HTTPException(status_code=502, detail="Could not reach ntfy. Check your topic and internet connection.")

def dispatch_assignment_reminders(settings):
    if not settings.get("ntfy_enabled"):
        raise HTTPException(status_code=400, detail="Notifications are disabled in Settings.")

    topic = settings.get("ntfy_topic", "")
    if not topic:
        raise HTTPException(status_code=400, detail="Add your ntfy topic in Settings first.")

    remind_hours = settings.get("notify_remind_hours", 24)
    try:
        remind_hours = max(1, min(int(remind_hours), 168))
    except (TypeError, ValueError):
        remind_hours = 24

    due_soon = get_assignments_for_reminder(remind_hours)
    if not due_soon:
        return {
            "status": "success",
            "message": f"No assignments due within the next {remind_hours} hours.",
            "sent": False,
            "assignment_count": 0,
            "remind_hours": remind_hours,
        }

    body = build_reminder_message(due_soon, settings.get("display_name"))
    result = send_ntfy(topic, body, title="Guino reminders")
    sent_at = datetime.now(LOCAL_TZ).isoformat()
    persist_notify_last_sent(sent_at)
    return {
        "status": "success",
        "message": f"Sent reminder for {len(due_soon)} assignment(s).",
        "sent": True,
        "assignment_count": len(due_soon),
        "remind_hours": remind_hours,
        "notify_last_sent_at": sent_at,
        "details": result,
    }

@app.post("/api/notify/reminders")
def send_assignment_reminders():
    settings = load_settings()
    try:
        return dispatch_assignment_reminders(settings)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        print(f"ntfy Error: {e}")
        raise HTTPException(status_code=502, detail="Could not reach ntfy. Check your topic and internet connection.")

@app.post("/api/cron/warm")
def cron_warm_ai_cache(
    authorization: Optional[str] = Header(None),
    x_cron_secret: Optional[str] = Header(None),
):
    require_cron_secret(authorization, x_cron_secret)
    started = time.time()
    jobs = {
        "study_plan": build_study_plan_payload,
        "flashcards": build_flashcards_payload,
        "courses_info": build_courses_info_payload,
    }
    results = {}
    for key, builder in jobs.items():
        try:
            payload = builder()
            _ai_cache_set(key, payload)
            results[key] = "ok"
        except Exception as e:
            print(f"Cron warm failed for {key}: {e}")
            results[key] = f"error: {e}"

    return {
        "status": "success",
        "message": "AI cache warm finished.",
        "elapsed_sec": round(time.time() - started, 2),
        "cache_ttl_sec": AI_CACHE_TTL_SEC,
        "results": results,
    }

@app.post("/api/cron/reminders")
def cron_assignment_reminders(
    authorization: Optional[str] = Header(None),
    x_cron_secret: Optional[str] = Header(None),
):
    require_cron_secret(authorization, x_cron_secret)
    settings = load_settings()
    should_send, reason = should_send_scheduled_reminder(settings)
    interval_hours = notify_check_interval_hours(settings.get("notify_remind_hours", 24))

    if not should_send:
        return {
            "status": "skipped",
            "sent": False,
            "reason": reason,
            "notify_check_interval_hours": interval_hours,
        }

    try:
        result = dispatch_assignment_reminders(settings)
        result["cron_reason"] = reason
        result["notify_check_interval_hours"] = interval_hours
        return result
    except HTTPException as e:
        return {
            "status": "skipped",
            "sent": False,
            "reason": e.detail,
            "notify_check_interval_hours": interval_hours,
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        print(f"ntfy Error: {e}")
        raise HTTPException(status_code=502, detail="Could not reach ntfy. Check your topic and internet connection.")

def build_study_plan_payload():
    courses = get_active_courses()
    assignments = get_all_upcoming_assignments(courses)
    top_tasks = assignments[:3]

    if not top_tasks:
        return {"status": "success", "plan": []}

    if GEMINI_API_KEY and GEMINI_API_KEY != "YOUR_GEMINI_API_KEY":
        try:
            client = genai.Client(api_key=GEMINI_API_KEY)
            settings = load_settings()
            custom_instructions = (settings.get("study_prompt") or DEFAULT_STUDY_PROMPT).strip()

            prompt = f"""
            {custom_instructions}

            Analyze these {len(top_tasks)} upcoming assignments and their descriptions written by the professor.

            Assignments:
            {json.dumps([{"title": t["title"], "course": t["course"], "description": t["description"], "hours_left": t["hours_left"]} for t in top_tasks])}

            Respond ONLY with a valid JSON array of objects.
            Format:
            [
              {{
                "title": "Assignment Title",
                "recommended_action": "1 sentence strategy",
                "estimated_time": "e.g., 2 hours",
                "steps": ["Step 1", "Step 2", "Step 3"]
              }}
            ]
            """

            response = client.models.generate_content(
                model='gemini-3.1-flash-lite',
                contents=prompt,
                config={"response_mime_type": "application/json"}
            )

            plan_data = json.loads(response.text.strip())
            return {"status": "success", "plan": plan_data}
        except Exception as e:
            print(f"Gemini API Error: {e}")

    mock_plan = []
    for t in top_tasks:
        mock_plan.append({
            "title": t["title"],
            "recommended_action": "Review the rubric attached in the description and outline your main points.",
            "estimated_time": "1.5 hours",
            "steps": ["Review lecture slides", "Draft an outline", "Write the final submission"]
        })
    return {"status": "success", "plan": mock_plan}

@app.get("/api/study_plan")
def get_study_plan():
    cached = _ai_cache_get("study_plan")
    if cached:
        return cached
    payload = build_study_plan_payload()
    _ai_cache_set("study_plan", payload)
    return payload

@app.get("/courses")
def serve_courses():
    with open("courses.html", "r") as f:
        return HTMLResponse(content=f.read())

def build_courses_info_payload():
    courses = get_active_courses()
    courses_dict = {}
    for c in courses:
        url = f"{BASE_URL}/courses/{c['id']}"
        params = {"include[]": "syllabus_body"}
        response = requests.get(url, headers=HEADERS, params=params)
        if response.status_code == 200:
            data = response.json()
            raw_syllabus = data.get("syllabus_body") or ""
            clean_syllabus = re.sub('<[^<]+>', '', raw_syllabus)[:1500]
            courses_dict[c["name"]] = {
                "syllabus": clean_syllabus,
                "upcoming": []
            }

    assignments = get_all_upcoming_assignments(courses)
    for a in assignments:
        if a["course"] in courses_dict:
            courses_dict[a["course"]]["upcoming"].append(a["title"])

    prompt_data = [{"course": k, "syllabus": v["syllabus"], "upcoming": v["upcoming"]} for k, v in courses_dict.items()]

    if GEMINI_API_KEY and GEMINI_API_KEY != "YOUR_GEMINI_API_KEY":
        try:
            client = genai.Client(api_key=GEMINI_API_KEY)
            prompt = f"""
            You are an expert academic advisor. Analyze these active courses, their syllabus text, and upcoming assignments.
            Provide:
            1. study_bullets: 2-3 highly specific, actionable bullet points on what to study or prioritize right now based on the assignments and syllabus context.
            2. grading_policy: A concise 1-2 sentence summary of the grading weights/policy (e.g., 'Exams are 40%, Homework is 20%'). If not found in the syllabus text, say "Grading policy not explicitly detailed in the Canvas syllabus."

            Data: {json.dumps(prompt_data)}

            Respond ONLY with a valid JSON array of objects matching this exact format:
            [
              {{
                "course": "Course Name",
                "study_bullets": ["Point 1", "Point 2"],
                "grading_policy": "Summary of grading policy"
              }}
            ]
            """

            response = client.models.generate_content(
                model='gemini-3.1-flash-lite',
                contents=prompt,
                config={
                    "response_mime_type": "application/json"
                }
            )

            plan_data = json.loads(response.text.strip())
            return {"status": "success", "courses_info": plan_data}
        except Exception as e:
            print(f"Gemini API Error: {e}")

    return {
        "status": "success",
        "courses_info": [
            {
                "course": c["name"],
                "study_bullets": ["Check Canvas for updates.", "Review recent lecture notes."],
                "grading_policy": "Unable to fetch grading policy or AI API key missing."
            } for c in courses
        ]
    }

@app.get("/api/courses_info")
def get_courses_info():
    cached = _ai_cache_get("courses_info")
    if cached:
        return cached
    payload = build_courses_info_payload()
    _ai_cache_set("courses_info", payload)
    return payload

@app.get("/api/feed")
def get_feed():
    courses = get_active_courses()
    assignments = get_all_upcoming_assignments(courses)
    return {"status": "success", "assignments": assignments}

@app.get("/api/grades")
def get_grades():
    courses = get_active_courses()
    grades = get_course_grades(courses)
    return {"status": "success", "grades": grades}

def build_flashcards_payload():
    courses = get_active_courses()
    assignments = get_all_upcoming_assignments(courses)
    top_tasks = assignments[:6]

    if not top_tasks:
        return {"status": "success", "flashcards": []}

    if GEMINI_API_KEY and GEMINI_API_KEY != "YOUR_GEMINI_API_KEY":
        try:
            client = genai.Client(api_key=GEMINI_API_KEY)

            prompt = f"""
            You are an expert study coach. For each of these {len(top_tasks)} assignments, write exactly 3 flashcards
            (a short question on the front, a concise answer on the back) that would genuinely help a student prepare,
            based on the assignment title, course, and the professor's description. Focus on key terms, likely concepts,
            or things worth reviewing before starting.

            Assignments:
            {json.dumps([{"title": t["title"], "course": t["course"], "description": t["description"]} for t in top_tasks])}

            Respond ONLY with a valid JSON array of objects.
            Format:
            [
              {{
                "assignment": "Assignment Title",
                "course": "Course Name",
                "cards": [
                  {{"front": "Question", "back": "Answer"}},
                  {{"front": "Question", "back": "Answer"}},
                  {{"front": "Question", "back": "Answer"}}
                ]
              }}
            ]
            """

            response = client.models.generate_content(
                model='gemini-3.1-flash-lite',
                contents=prompt,
                config={"response_mime_type": "application/json"}
            )

            deck_data = json.loads(response.text.strip())
            return {"status": "success", "flashcards": deck_data}
        except Exception as e:
            print(f"Gemini API Error (flashcards): {e}")

    mock_decks = []
    for t in top_tasks:
        mock_decks.append({
            "assignment": t["title"],
            "course": t["course"],
            "cards": [
                {"front": f"What is the main goal of \"{t['title']}\"?", "back": "Check the assignment brief on Canvas for the full rubric and requirements."},
                {"front": "What should you review first?", "back": "Your lecture notes and any linked readings for this topic."},
                {"front": "How much time should you budget?", "back": "Start early \u2014 block out at least 1-2 focused hours."}
            ]
        })
    return {"status": "success", "flashcards": mock_decks}

@app.get("/api/flashcards")
def get_flashcards():
    cached = _ai_cache_get("flashcards")
    if cached:
        return cached
    payload = build_flashcards_payload()
    _ai_cache_set("flashcards", payload)
    return payload

# Run server
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)