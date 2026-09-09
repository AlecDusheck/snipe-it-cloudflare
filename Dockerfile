# Upstream's Alpine image (Apache + PHP 8.4) plus MariaDB. Both must share one container:
# outbound handlers only carry HTTP, so nothing can route port 3306 between two of them.
FROM docker.io/snipe/snipe-it:v8-latest-alpine

RUN apk add --no-cache bash curl jq mariadb mariadb-client php84-opcache su-exec supervisor \
	&& mkdir -p /var/lib/mysql && chown mysql:mysql /var/lib/mysql

COPY container/conf/mariadb.cnf /etc/my.cnf.d/90-snipeit-cf.cnf
COPY container/conf/apache.conf /etc/apache2/conf.d/zz-snipe-cf.conf
COPY container/conf/php.ini /etc/php84/conf.d/99-snipe-cf.ini
COPY container/conf/supervisord.conf /etc/supervisord.conf
COPY --chmod=755 container/lib/ /opt/snipeit-cf/

EXPOSE 80
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/opt/snipeit-cf/entrypoint.sh"]
