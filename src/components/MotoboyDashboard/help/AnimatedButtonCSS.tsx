
import { MdClose, MdOutlinePayments } from "react-icons/md";
import "../MotoboyDashboard.css";

type ChildProps = {
  handleClick: () => void; // assinatura do callback
  index: number;
};

export default function AnimatedIconButtonCSS({ handleClick, index }: ChildProps) {
  return (
    <div className="icon-button">
      <button
        type="button"
        onClick={handleClick}
        className={index ? "icon-container u" : "icon-container z"}
        aria-expanded={Boolean(index)}
      >
        {index ? <MdClose size={18} /> : <MdOutlinePayments size={18} />}
        <span>{index ? "Fechar" : "Fechamento"}</span>
      </button>
    </div>
  );
}
