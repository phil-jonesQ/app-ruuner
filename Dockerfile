# Stage 1: Build the React Frontend
FROM node:20-alpine as builder

WORKDIR /app

# Copy package files and install ALL dependencies (including devDependencies for Vite)
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Build the frontend (outputs to /app/dist)
RUN npm run build

# Stage 2: Setup the Production Server
FROM node:20-alpine

WORKDIR /app

# Copy package files again to install only runtime dependencies (Express, etc.)
COPY package*.json ./
RUN npm install --omit=dev

# Copy the built frontend assets from the builder stage
COPY --from=builder /app/dist ./dist

# Copy the server code
COPY server ./server

# Create the data directory (mount point)
RUN mkdir -p /data

# Set environment variables
ENV PORT=2001
ENV DATA_DIR=/data
ENV NODE_ENV=production

# Expose the port
EXPOSE 2001

# Start the server
CMD ["npm", "run", "server"]
