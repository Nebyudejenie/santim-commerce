export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <div>
          <p className="site-footer__mark">LUMEN</p>
          <p className="site-footer__tag">Minimal essentials, built for Addis and beyond.</p>
        </div>
        <div className="site-footer__col">
          <p className="site-footer__heading">Help</p>
          <p>Shipping</p>
          <p>Returns</p>
          <p>Order lookup</p>
        </div>
        <div className="site-footer__col">
          <p className="site-footer__heading">Payment</p>
          <p>Telebirr · CBE Birr · Amole</p>
          <p>Secured by SantimPay</p>
        </div>
      </div>
      <div className="container site-footer__bottom">
        <span>© {new Date().getFullYear()} LUMEN. All rights reserved.</span>
      </div>
    </footer>
  );
}
