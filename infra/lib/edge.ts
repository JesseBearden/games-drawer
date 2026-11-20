import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import type { Construct } from 'constructs';

export interface GamesDrawerEdgeProps extends cdk.StackProps {
  /** The site's domain; www.<domain> redirects to it and staging.<domain> shows the newest box. */
  domain: string;
}

/**
 * The front door, which never changes when a game server box does: the domain's DNS (Route 53),
 * its HTTPS certificate, and CloudFront. CloudFront talks to whichever box `origin.<domain>`
 * points at (the fleet tool moves that record when a new box takes over, deploy/fleet.ts), in
 * plain HTTP; the boxes take that port from CloudFront only. Pages, game connections and voice
 * set-up all pass straight through (nothing is cached but the build's hashed files), and the
 * box routes each request to the right box itself (deploy/fleetMap.ts).
 *
 * In us-east-1 because CloudFront only takes certificates from there.
 */
export class GamesDrawerEdgeStack extends cdk.Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: GamesDrawerEdgeProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add('project', 'games-drawer');
    const { domain } = props;
    const names = [domain, `www.${domain}`, `staging.${domain}`];

    // Kept if the stack is ever deleted: a new zone would get new nameservers to re-enter at the registrar.
    const zone = new route53.PublicHostedZone(this, 'Zone', { zoneName: domain, comment: 'Games Drawer' });
    zone.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: domain,
      subjectAlternativeNames: names.slice(1),
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // Plain HTTP to the box: HTTPS ends here. Game connections send a ping every 2 seconds, so
    // they never sit idle long enough to time out.
    const origin = new origins.HttpOrigin(`origin.${domain}`, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
      readTimeout: cdk.Duration.seconds(60),
      keepaliveTimeout: cdk.Duration.seconds(60),
    });

    this.distribution = new cloudfront.Distribution(this, 'FrontDoor', {
      comment: 'Games Drawer',
      domainNames: names,
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // North America and Europe edges: the cheapest set, and where the players are.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Everything goes to the box as it came (the host name, ?slot= and the player's address
        // in CloudFront-Viewer-Address), and nothing is cached.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022,
        compress: true,
      },
      additionalBehaviors: {
        // The build's files have a hash in their names, so they can be kept at the edge for good.
        '/assets/*': {
          origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          compress: true,
        },
      },
    });

    const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(this.distribution));
    names.forEach((name, i) => {
      const id = ['Site', 'Www', 'Staging'][i];
      new route53.ARecord(this, `${id}V4`, { zone, recordName: name, target });
      new route53.AaaaRecord(this, `${id}V6`, { zone, recordName: name, target });
    });

    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(' ', zone.hostedZoneNameServers!),
      description: 'Enter these at the registrar (Squarespace) as the domain’s nameservers',
    });
    new cdk.CfnOutput(this, 'DistributionId', { value: this.distribution.distributionId });
  }
}
