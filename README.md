# Pangalink.net

## Kiirinstall

Kui kasutad [dockerit](http://docker.io/) on pangalink.net käivitamine imelihtne.

Käivita selle jaoks pangalink.net docker konteiner:

    sudo docker build -t=pangalink.net git://github.com/andris9/pangalink.net.git
    sudo docker run -d -p 80:80 pangalink.net

Ja ava brauseris [localhost](http://localhost).

## Tavainstall

## Eeldused

  * [Node.js](http://nodejs.org/)
  * [Redis](http://redis.io/)
  * [MongoDB](http://www.mongodb.org/)
  * GIT (koodi alla laadimiseks ja uuendamiseks, pole otseselt vajalik)

## Install

    git clone git://github.com/andris9/pangalink.net.git
    cd pangalink.net
    npm install

## Konfiguratsioon

Muuda faili `config/development.json` väärtusi või kopeeri see fail mõne teise nimega failiks, näiteks `config/production.json` ja muuda selle sisu (soovitatud käitumine).

## Käivitamine

    NODE_ENV=development node index.json

kus `development` on konfiguratsioonifaili nimi ilma `.json` liideseta.

Juhul kui veebiliides kasutab porti 80 või 443, pead käivitama rakenduse juurkasutaja kasutaja õigustes.

## Init skripti kasutamine

Lisa pangalink.net juurkataloogi fail nimega `.node_env` mille sisuks on konfiguratsioonifaili nimi ilma `.json` liideseta.

    echo "development" > /path/to/pangalink.net/.node_env

Juhul kui seda faili pole, kasutatakse NODE_ENV väärtusena "production"

Lingi init skript `/etc/init.d` kausta (ainult juurkasutaja õigustes)

    ln -s /path/to/pangalink.net/setup/pangalink.net /etc/init.d/pangalink.net

Lisa rakendus automaatselt käivitatavate rakenduste nimekirja

**Ubuntu/Debian**

    update-rc.d pangalink.net defaults

**CentOs/RHEL**

    chkconfig pangalink.net on

## Litsents

**MIT**
