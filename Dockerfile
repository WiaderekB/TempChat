FROM python:3.14-slim-trixie AS app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATA_DIR=/data

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && groupadd --system --gid 10001 tempchat \
    && useradd --system --uid 10001 --gid tempchat --no-create-home tempchat \
    && install -d -o tempchat -g tempchat /data /run/tex
COPY server.py assets.py tex_worker.py schema.sql ./
COPY web/ ./web/

USER tempchat
EXPOSE 3087
CMD ["gunicorn", "--bind", "0.0.0.0:3087", "--workers", "1", "--worker-class", "gthread", "--threads", "8", "--timeout", "90", "server:create()"]

FROM python:3.14-slim-trixie AS tex
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends texlive-latex-base texlive-latex-recommended \
        texlive-latex-extra texlive-fonts-recommended texlive-pictures texlive-science \
        texlive-lang-polish texlive-xetex \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 tempchat \
    && useradd --system --uid 10001 --gid tempchat --no-create-home tempchat \
    && install -d -o tempchat -g tempchat /run/tex
WORKDIR /app
COPY assets.py tex_worker.py ./
USER tempchat
CMD ["python", "tex_worker.py"]

FROM app AS default
