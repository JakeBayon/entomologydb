from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.utils import secure_filename
import os
from datetime import datetime
import smtplib
from email.message import EmailMessage

app = Flask(__name__)
CORS(app)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_FOLDER = os.path.join(BASE_DIR, "uploads")
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

app.config["UPLOAD_FOLDER"] = UPLOAD_FOLDER
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16 MB max upload

ALLOWED_EXTENSIONS = {
    "png", "jpg", "jpeg", "gif", "webp",
    "pdf", "doc", "docx", "txt", "csv", "xlsx"
}

EMAIL_SENDER = "jwbayon23@gmail.com"
EMAIL_RECEIVER = "jwbayon23@gmail.com"
EMAIL_APP_PASSWORD = os.getenv("BRUCHINDB_EMAIL_APP_PASSWORD")

def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def build_unique_filename(filename):
    safe_name = secure_filename(filename)
    name, ext = os.path.splitext(safe_name)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    return f"{name}_{timestamp}{ext}"


def send_submission_email(first_name, last_name, email, saved_file_paths):
    msg = EmailMessage()
    msg["Subject"] = "BruchinDB | You Received a New Seed Beetle Submission!"
    msg["From"] = EMAIL_SENDER
    msg["To"] = EMAIL_RECEIVER

    attached_names = [os.path.basename(path) for path in saved_file_paths]

    msg.set_content(
        f"""A new BruchinDB seed beetle submission was received.

First name: {first_name}
Last name: {last_name}
Email: {email}

Attached files:
{chr(10).join(attached_names) if attached_names else "No files attached"}
"""
    )

    for file_path in saved_file_paths:
        with open(file_path, "rb") as f:
            file_data = f.read()
            file_name = os.path.basename(file_path)

        msg.add_attachment(
            file_data,
            maintype="application",
            subtype="octet-stream",
            filename=file_name
        )

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:
        smtp.login(EMAIL_SENDER, EMAIL_APP_PASSWORD)
        smtp.send_message(msg)


@app.route("/upload", methods=["POST"])
def upload():
    first_name = request.form.get("firstName", "").strip()
    last_name = request.form.get("lastName", "").strip()
    email = request.form.get("email", "").strip()

    photo_file = request.files.get("photoFile")
    info_file = request.files.get("infoFile")

    if not first_name or not last_name or not email:
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

        send_submission_email(first_name, last_name, email, saved_file_paths)

        return jsonify({
            "success": True,
            "message": "Submission received successfully.",
            "firstName": first_name,
            "lastName": last_name,
            "email": email,
            "savedFiles": saved_files
        }), 200

    except Exception as error:
        return jsonify({
            "success": False,
            "error": f"Server error: {str(error)}"
        }), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)