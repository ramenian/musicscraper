# Use a lightweight, official Node.js image
FROM node:18-alpine

# Create a folder inside the container for our app
WORKDIR /usr/src/app

# Copy the package.json files first (for efficient caching)
COPY package*.json ./

# Install the dependencies
RUN npm install --production

# Copy all the rest of your HTML and JS files into the container
COPY . .

# Expose port 80 
EXPOSE 80

# The command to start the app
CMD ["npm", "start"]
