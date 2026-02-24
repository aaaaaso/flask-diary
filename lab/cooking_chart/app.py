import os

from flask import Flask

from lab_app import bp as cooking_chart_bp

app = Flask(__name__)
app.register_blueprint(cooking_chart_bp)


if __name__ == "__main__":
    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "5050"))
    app.run(debug=True, host=host, port=port)
