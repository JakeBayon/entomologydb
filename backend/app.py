from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.utils import secure_filename
import os
from datetime import datetime
import smtplib
import mimetypes
from email.message import EmailMessage

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16 mb max upload

ALLOWED_EXTENSIONS = {
    "png", "jpg", "jpeg", "gif", "webp",
    "pdf", "doc", "docx", "txt", "csv", "xlsx"
}

EMAIL_SENDER = os.getenv("BRUCHINDB_EMAIL_SENDER", "bruchindb26@gmail.com")
EMAIL_RECEIVER = os.getenv("BRUCHINDB_EMAIL_RECEIVER", "jbayon@sandiego.edu")

# fixed: directly define password (no getenv)
EMAIL_APP_PASSWORD = "qjwxbnzyidqpmmvb"


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def build_unique_filename(filename):
    safe_name = secure_filename(filename)
    name, ext = os.path.splitext(safe_name)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    return f"{name}_{timestamp}{ext}"


def get_mime_type(file_path):
    mime_type, _ = mimetypes.guess_type(file_path)
    if mime_type and "/" in mime_type:
        return mime_type.split("/", 1)
    return "application", "octet-stream"


def send_submission_email(form_data, saved_file_paths):
    if not EMAIL_APP_PASSWORD:
        raise RuntimeError("Missing email app password.")

    msg = EmailMessage()
    msg["Subject"] = "BruchinDB | New Seed Beetle Submission"
    msg["From"] = EMAIL_SENDER
    msg["To"] = EMAIL_RECEIVER

    submitter_email = form_data.get("email", "").strip()
    if submitter_email:
        msg["Reply-To"] = submitter_email

    attached_names = [os.path.basename(path) for path in saved_file_paths]

    msg.set_content(
        f"""A new BruchinDB seed beetle submission was received.

collector
first name: {form_data.get("firstName", "")}
last name: {form_data.get("lastName", "")}
email: {form_data.get("email", "")}

locality
latitude: {form_data.get("latitude", "")}
longitude: {form_data.get("longitude", "")}
location description: {form_data.get("locationDescription", "")}

host
host plant name: {form_data.get("hostPlantName", "")}
host type: {form_data.get("hostType", "")}

collection
collection date: {form_data.get("collectionDate", "")}

notes
description: {form_data.get("description", "")}

attached files:
{chr(10).join(attached_names) if attached_names else "No files attached"}
"""
    )

    for file_path in saved_file_paths:
        with open(file_path, "rb") as f:
            file_data = f.read()
            file_name = os.path.basename(file_path)

        maintype, subtype = get_mime_type(file_path)

        msg.add_attachment(
            file_data,
            maintype=maintype,
            subtype=subtype,
            filename=file_name
        )

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(EMAIL_SENDER, EMAIL_APP_PASSWORD)
        smtp.send_message(msg)


@app.route("/upload", methods=["POST"])
def upload():
    form_data = {
        "firstName": request.form.get("firstName", "").strip(),
        "lastName": request.form.get("lastName", "").strip(),
        "email": request.form.get("email", "").strip(),
        "latitude": request.form.get("latitude", "").strip(),
        "longitude": request.form.get("longitude", "").strip(),
        "locationDescription": request.form.get("locationDescription", "").strip(),
        "hostPlantName": request.form.get("hostPlantName", "").strip(),
        "hostType": request.form.get("hostType", "").strip(),
        "collectionDate": request.form.get("collectionDate", "").strip(),
        "description": request.form.get("description", "").strip()
    }

    photo_file = request.files.get("photoFile")
    info_file = request.files.get("infoFile")

    if not form_data["firstName"] or not form_data["lastName"] or not form_data["email"]:
        return jsonify({
            "success": False,
            "error": "Missing contact information."
        }), 400

    if not photo_file and not info_file:
        return jsonify({
            "success": False,
            "error": "No files were uploaded."
        }), 400

    saved_files = []
    saved_file_paths = []

    try:
        if photo_file and photo_file.filename:
            if not allowed_file(photo_file.filename):
                return jsonify({
                    "success": False,
                    "error": "Invalid photo file type."
                }), 400

            photo_name = build_unique_filename(photo_file.filename)
            photo_path = os.path.join(app.config["UPLOAD_FOLDER"], photo_name)
            photo_file.save(photo_path)
            saved_files.append(photo_name)
            saved_file_paths.append(photo_path)

        if info_file and info_file.filename:
            if not allowed_file(info_file.filename):
                return jsonify({
                    "success": False,
                    "error": "Invalid additional info file type."
                }), 400

            info_name = build_unique_filename(info_file.filename)
            info_path = os.path.join(app.config["UPLOAD_FOLDER"], info_name)
            info_file.save(info_path)
            saved_files.append(info_name)
            saved_file_paths.append(info_path)

        send_submission_email(form_data, saved_file_paths)

        return jsonify({
            "success": True,
            "message": "Submission received successfully.",
            "savedFiles": saved_files
        }), 200

    except Exception as error:
        return jsonify({
            "success": False,
            "error": f"Server error: {str(error)}"
        }), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)