FROM ubuntu

RUN apt-mark hold initscripts udev plymouth mountall

# Uuenda süsteem
RUN apt-get update
RUN apt-get upgrade -y

# Installi Node.Js, Redis ja Git
RUN apt-get install -y python-software-properties software-properties-common git
RUN add-apt-repository -y ppa:chris-lea/node.js
RUN add-apt-repository -y ppa:chris-lea/redis-server
RUN apt-key adv --keyserver hkp://keyserver.ubuntu.com:80 --recv 7F0CEB10
RUN echo 'deb http://downloads-distro.mongodb.org/repo/ubuntu-upstart dist 10gen' | tee /etc/apt/sources.list.d/mongodb.list
RUN echo "deb http://archive.ubuntu.com/ubuntu precise universe" >> /etc/apt/sources.list
RUN apt-get update
RUN apt-get install -y nodejs redis-server build-essential mongodb-10gen
RUN mkdir -p /data/db

# Installi pangalink.net
RUN cd /opt && git clone git://github.com/andris9/pangalink.net.git && cd pangalink.net && npm install
RUN sed 's/3480/80/' /opt/pangalink.net/config/development.json > /opt/pangalink.net/config/production.json

ADD setup/start.sh /start.sh
RUN chmod +x /start.sh

ENV NODE_ENV production

# Luba port 3306 väljaspoolt
EXPOSE 80

# Käivita peale virtuaalmasina loomist
CMD ["/start.sh"]